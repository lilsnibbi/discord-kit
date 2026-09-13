import {
	Client,
	type ClientOptions,
	type Guild,
	Routes,
	type APIApplicationCommand,
} from "discord.js";
import { Logger, type LoggerOptions } from "@lilsnibbi/logger";
import { DiscordCommand } from "./DiscordCommand";
import { type AnyDiscordEvent, DiscordEvent } from "./DiscordEvent";
import {
	discoverDiscordModules,
	importDiscordModule,
	type DiscordModuleOptions,
} from "./DiscordModuleLoader";
import {
	runDiscordShutdown,
	validateShutdownTimeout,
	type DiscordShutdownPhase,
} from "./DiscordShutdown";
import { container } from "./container";

/** The bot-specific half of {@link DiscordClientOptions}. */
export interface DiscordClientCustomOptions {
	/** Configuration for the client's logger. */
	logger: LoggerOptions;
	/** Environment variables checked before setup, imports or login. */
	requiredEnvs: string[];
	/** Project root used to resolve module directories. */
	root: string;
	/** Default token for `login` and `init`. */
	botToken: string;
	/** Default guild for command registration and `mainGuild`. */
	operatingGuildId?: string;
	/** Application ID override, useful for registration before gateway login. */
	applicationId?: string;
	/** Module discovery configuration. Omit to use manual imports only. */
	modules?: DiscordModuleOptions;
	/** Duplicate command-name policy. Defaults to `replace` for compatibility. */
	duplicateCommands?: "replace" | "skip" | "error";
	/** Total `kill` deadline. Defaults to 7,000ms. */
	shutdownTimeoutMs?: number;
}

/** discord.js options plus the client's own settings. */
export interface DiscordClientOptions extends ClientOptions {
	/** Settings specific to discord-kit. */
	custom: DiscordClientCustomOptions;
}

/** The pieces registered to a client, preserving its subclass type. */
export interface DiscordClientComponents<C extends Client = DiscordClient> {
	/** Events awaiting attachment; emptied when listeners are bound. */
	events: Set<AnyDiscordEvent<C>>;
	/** Commands by `data.name`; names must be unique across command types. */
	commands: Map<string, DiscordCommand<C>>;
}

/** Options for explicitly replacing an application's command set. */
export interface DiscordCommandRegistrationOptions {
	/** Guild ID, or `null` to explicitly target global commands. */
	guildId?: string | null;
	/** Overrides the configured or logged-in application ID. */
	applicationId?: string;
	/** Permit an empty registry to delete all commands in this scope. */
	allowEmpty?: boolean;
	/** Re-send an unchanged set after a previous successful registration. */
	force?: boolean;
}

/** Where an asynchronous client failure originated. */
export type DiscordClientErrorContext =
	| { type: "event"; source: AnyDiscordEvent["type"]; name: string }
	| { type: "shutdown"; name: string };

/** Placement and deadline for an application-owned cleanup hook. */
export interface DiscordShutdownHookOptions {
	/** Stop intake, drain work, or clean up after Discord disconnects. Default: cleanup. */
	stage?: "stop" | "drain" | "cleanup";
	/** Deadline for this hook. Defaults to 1,500ms. */
	timeoutMs?: number;
}

/** A point-in-time snapshot; memory sizes are bytes and caches are entry counts. */
export interface DiscordClientStats {
	ready: boolean;
	uptime: number | null;
	ping: number;
	memory: ReturnType<typeof process.memoryUsage>;
	cache: {
		guilds: number;
		users: number;
		channels: number;
		members: number;
		presences: number;
		messages: number;
	};
	commands: number;
	events: number;
}

/**
 * A Discord client with module discovery, typed pieces, command registration
 * and application-owned lifecycle hooks. `login` attaches pieces; `init` also
 * awaits `setup`. Neither dispatches interactions or registers commands remotely.
 */
export class DiscordClient extends Client {
	/** Logger constructed from `custom.logger`. */
	public readonly log: Logger;
	/** Settings supplied to the constructor. */
	public readonly custom: DiscordClientCustomOptions;
	/** Registry with handlers typed to this client. */
	public readonly components: DiscordClientComponents<this>;
	private readonly boundEvents = new Map<AnyDiscordEvent<this>, () => void>();
	private readonly registeredEvents = new Set<AnyDiscordEvent<this>>();
	private readonly loadedPaths = new Set<string>();
	private readonly stopController = new AbortController();
	private readonly shutdownHooks: {
		phase: DiscordShutdownPhase;
		stage: "stop" | "drain" | "cleanup";
	}[] = [];
	private moduleQueue: Promise<void> = Promise.resolve();
	private setupPromise?: Promise<void>;
	private initPromise?: Promise<void>;
	private loginPromise?: Promise<string>;
	private killPromise?: Promise<void>;
	private destroyPromise?: Promise<void>;
	private eventsActive = false;
	private readonly commandQueues = new Map<
		string,
		Promise<APIApplicationCommand[]>
	>();
	private readonly commandRegistrations = new Map<
		string,
		{ body: string; result: APIApplicationCommand[] }
	>();

	constructor(ops: DiscordClientOptions) {
		validateShutdownTimeout(ops.custom.shutdownTimeoutMs ?? 7_000);
		super(ops);
		this.custom = ops.custom;
		this.log = new Logger({ ...this.custom.logger });
		this.components = { events: new Set(), commands: new Map() };
		container.client = this;
	}

	/** Alias for `components.commands`, suitable for existing Lumi dispatchers. */
	public get commands(): Map<string, DiscordCommand<this>> {
		return this.components.commands;
	}

	/** Reads this client's cache on every access; never shares a guild between clients. */
	public get mainGuild(): Guild {
		const id = this.custom.operatingGuildId;
		if (!id) throw new Error("No operatingGuildId configured");
		const guild = this.guilds.cache.get(id);
		if (!guild) throw new Error(`Operating guild ${id} is not cached`);
		return guild;
	}

	/** Fetches the configured guild when cache-only `mainGuild` is insufficient. */
	public async fetchMainGuild(): Promise<Guild> {
		const id = this.custom.operatingGuildId;
		if (!id) throw new Error("No operatingGuildId configured");
		return await this.guilds.fetch(id);
	}

	/** Aborted immediately when `kill` or `destroy` stops new work. */
	public get shutdownSignal(): AbortSignal {
		return this.stopController.signal;
	}

	/** Whether shutdown has started; no new pieces or startup work are accepted. */
	public get isShuttingDown(): boolean {
		return this.shutdownSignal.aborted;
	}

	/** Throws with missing variable names, never their values. */
	public validateEnv(): void {
		const missing = this.custom.requiredEnvs.filter(
			(key) => !Bun.env[key]?.trim(),
		);
		if (missing.length)
			throw new Error(`Missing env vars: ${missing.join(", ")}`);
	}

	private assertActive(): void {
		if (this.isShuttingDown)
			throw new Error("DiscordClient is shutting down or destroyed");
	}

	/** Override to initialize application services before module imports and login. */
	protected async setup(): Promise<void> {}

	/**
	 * Runs setup once, then logs in. Concurrent calls share startup; failed setup
	 * can be retried. Setup implementations must clean up partial failures themselves.
	 * A gateway failure may destroy the underlying discord.js client; construct a
	 * new instance in that case. Does not await asynchronous ready handlers.
	 */
	public init(token = this.custom.botToken): Promise<void> {
		if (this.isShuttingDown)
			return Promise.reject(
				new Error("DiscordClient is shutting down or destroyed"),
			);
		if (this.initPromise) return this.initPromise;
		this.initPromise = Promise.resolve()
			.then(async () => {
				this.assertActive();
				this.validateEnv();
				this.setupPromise ??= Promise.resolve()
					.then(() => this.setup())
					.catch((error) => {
						this.setupPromise = undefined;
						throw error;
					});
				await this.setupPromise;
				this.assertActive();
				await this.login(token);
			})
			.catch((error) => {
				this.initPromise = undefined;
				throw error;
			});
		return this.initPromise;
	}

	/** Validates the environment, loads configured modules, and connects once. */
	public override login(token = this.custom.botToken): Promise<string> {
		if (this.isShuttingDown)
			return Promise.reject(
				new Error("DiscordClient is shutting down or destroyed"),
			);
		if (this.loginPromise) return this.loginPromise;
		this.loginPromise = Promise.resolve()
			.then(async () => {
				this.assertActive();
				this.validateEnv();
				await this.loadModules();
				this.assertActive();
				const result = await super.login(token);
				if (this.isShuttingDown) {
					await super.destroy();
					this.assertActive();
				}
				return result;
			})
			.catch((error) => {
				this.loginPromise = undefined;
				throw error;
			});
		return this.loginPromise;
	}

	/**
	 * Imports sorted default-exported pieces or factories `(client) => piece`.
	 * Factories can return arrays. Successful paths are loaded once per client;
	 * failures reject startup and remain retryable. Side-effect imports are supported.
	 */
	public loadModules(
		options: DiscordModuleOptions = this.custom.modules ?? {},
	): Promise<void> {
		const load = this.moduleQueue
			.catch(() => {})
			.then(async () => {
				this.assertActive();
				this.validateEnv();
				for (const path of await discoverDiscordModules(
					this.custom.root,
					options,
				)) {
					this.assertActive();
					if (this.loadedPaths.has(path)) continue;
					try {
						let value = await importDiscordModule(path);
						this.assertActive();
						if (typeof value === "function") value = await value(this);
						this.assertActive();
						const pieces = (Array.isArray(value) ? value : [value]).filter(
							(piece) => piece !== undefined,
						);
						const names = new Map(this.commands);
						// Validate the whole export before changing the registry.
						for (const piece of pieces) {
							if (
								!(piece instanceof DiscordEvent) &&
								!(piece instanceof DiscordCommand)
							) {
								throw new TypeError(
									"Expected a DiscordCommand or DiscordEvent default export",
								);
							}
							if (piece instanceof DiscordCommand) {
								const previous = names.get(piece.data.name);
								if (
									previous &&
									previous !== piece &&
									this.custom.duplicateCommands === "error"
								) {
									throw new Error(`Duplicate command: ${piece.data.name}`);
								}
								names.set(piece.data.name, piece);
							}
						}
						for (const piece of pieces) this.addPiece(piece);
						this.loadedPaths.add(path);
					} catch (cause) {
						throw new Error(`Failed to load Discord module: ${path}`, {
							cause,
						});
					}
				}
				this.assertActive();
				this.eventsActive = true;
				for (const event of this.components.events) this.bindEvent(event);
			});
		this.moduleQueue = load;
		return load;
	}

	/** Register a piece, retaining contextual event-source and subclass inference. */
	// biome-ignore lint/suspicious/noExplicitAny: event-name widening preserves source inference
	public registerPiece(piece: DiscordEvent<"client", any, this>): void;
	// biome-ignore lint/suspicious/noExplicitAny: event-name widening preserves source inference
	public registerPiece(piece: DiscordEvent<"rest", any, this>): void;
	// biome-ignore lint/suspicious/noExplicitAny: event-name widening preserves source inference
	public registerPiece(piece: DiscordEvent<"custom", any, this>): void;
	public registerPiece(piece: DiscordCommand<this>): void;
	public registerPiece(
		piece: AnyDiscordEvent<this> | DiscordCommand<this>,
	): void {
		this.addPiece(piece);
	}

	private addPiece(piece: AnyDiscordEvent<this> | DiscordCommand<this>): void {
		this.assertActive();
		if (piece instanceof DiscordEvent) {
			if (this.registeredEvents.has(piece)) return;
			this.registeredEvents.add(piece);
			this.components.events.add(piece);
			if (this.eventsActive) this.bindEvent(piece);
			return;
		}
		if (piece instanceof DiscordCommand) {
			const previous = this.commands.get(piece.data.name);
			if (previous && previous !== piece) {
				if (this.custom.duplicateCommands === "error")
					throw new Error(`Duplicate command: ${piece.data.name}`);
				if (this.custom.duplicateCommands === "skip") return;
			}
			this.commands.set(piece.data.name, piece);
			return;
		}
		const label = (piece as object)?.constructor?.name ?? String(piece);
		this.log.alert(`Unsupported piece loaded. Piece: ${label}`, {
			box: { topRight: "PieceLoader" },
		});
	}

	/** Detaches only this piece; a replaced command cannot remove its replacement. */
	public unregisterPiece(
		piece: AnyDiscordEvent<this> | DiscordCommand<this>,
	): boolean {
		if (piece instanceof DiscordCommand) {
			return (
				this.commands.get(piece.data.name) === piece &&
				this.commands.delete(piece.data.name)
			);
		}
		this.boundEvents.get(piece)?.();
		this.boundEvents.delete(piece);
		this.components.events.delete(piece);
		return this.registeredEvents.delete(piece);
	}

	private bindEvent(event: AnyDiscordEvent<this>): void {
		if (this.boundEvents.has(event)) return;
		const listener = (...args: unknown[]) => {
			if (event.once) this.boundEvents.delete(event);
			if (this.isShuttingDown) return;
			try {
				Promise.resolve(event.method(this, ...args)).catch((error) =>
					this.reportError(error, {
						type: "event",
						source: event.type,
						name: String(event.name),
					}),
				);
			} catch (error) {
				void this.reportError(error, {
					type: "event",
					source: event.type,
					name: String(event.name),
				});
			}
		};
		if (event.type === "rest") {
			this.rest[event.once ? "once" : "on"](event.name, listener);
			this.boundEvents.set(event, () => this.rest.off(event.name, listener));
		} else {
			this[event.once ? "once" : "on"](event.name, listener);
			this.boundEvents.set(event, () => this.off(event.name, listener));
		}
		this.components.events.delete(event);
	}

	/** Override to integrate an application's error reporter. */
	protected onError(
		error: unknown,
		context: DiscordClientErrorContext,
	): void | Promise<void> {
		this.log.error(
			new Error(`[${context.type}:${context.name}] ${String(error)}`, {
				cause: error,
			}),
		);
	}

	private async reportError(
		error: unknown,
		context: DiscordClientErrorContext,
	): Promise<void> {
		try {
			await this.onError(error, context);
		} catch (reportError) {
			// Reporter failures must not become unhandled event rejections.
			try {
				this.log.error(
					new AggregateError(
						[error, reportError],
						"Client error reporter failed",
					),
				);
			} catch {}
		}
	}

	/**
	 * Bulk-replaces commands in one explicit scope. No REST calls happen during login.
	 * Identical successful bodies are skipped; failures are retryable and requests
	 * for the same scope are serialized. Empty sets require `allowEmpty: true`.
	 */
	public async registerCommands(
		options: DiscordCommandRegistrationOptions = {},
	): Promise<APIApplicationCommand[]> {
		this.assertActive();
		const applicationId =
			options.applicationId ??
			this.custom.applicationId ??
			this.application?.id ??
			this.user?.id;
		if (!applicationId)
			throw new Error(
				"An application ID or logged-in client is required to register commands",
			);
		const guildId =
			options.guildId === undefined
				? this.custom.operatingGuildId
				: options.guildId;
		if (guildId === undefined || guildId === "")
			throw new Error(
				"Set operatingGuildId or pass guildId (null for global commands)",
			);
		const body = [...this.commands.values()].map(({ data }) => data.toJSON());
		if (!body.length && !options.allowEmpty)
			throw new Error("Refusing to clear commands without allowEmpty: true");
		const route =
			guildId === null
				? Routes.applicationCommands(applicationId)
				: Routes.applicationGuildCommands(applicationId, guildId);
		const serialized = JSON.stringify(body);
		const request = (this.commandQueues.get(route) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				this.assertActive();
				const previous = this.commandRegistrations.get(route);
				if (!options.force && previous?.body === serialized)
					return previous.result;
				const result = (await this.rest.put(route, {
					body,
				})) as APIApplicationCommand[];
				this.commandRegistrations.set(route, { body: serialized, result });
				return result;
			});
		this.commandQueues.set(route, request);
		try {
			return await request;
		} finally {
			if (this.commandQueues.get(route) === request)
				this.commandQueues.delete(route);
		}
	}

	/** Registers an ordered cleanup hook; returns a function that removes it. */
	public addShutdownHook(
		label: string,
		task: (signal: AbortSignal) => unknown | Promise<unknown>,
		options: DiscordShutdownHookOptions = {},
	): () => void {
		this.assertActive();
		validateShutdownTimeout(options.timeoutMs ?? 1_500);
		const hook = {
			phase: { label, tasks: [task], timeoutMs: options.timeoutMs },
			stage: options.stage ?? "cleanup",
		};
		this.shutdownHooks.push(hook);
		return () => {
			const index = this.shutdownHooks.indexOf(hook);
			if (index !== -1) this.shutdownHooks.splice(index, 1);
		};
	}

	/**
	 * Stops registered event intake immediately, then runs stop/drain hooks,
	 * disconnects Discord, and runs cleanup hooks. Repeated calls share one promise.
	 * Failures are reported and cleanup continues within the total deadline.
	 */
	public kill(): Promise<void> {
		if (this.killPromise) return this.killPromise;
		const phases = (stage: "stop" | "drain" | "cleanup") =>
			this.shutdownHooks
				.filter((hook) => hook.stage === stage)
				.map((hook) => hook.phase);
		this.killPromise = Promise.resolve().then(async () => {
			try {
				await runDiscordShutdown(
					[
						...phases("stop"),
						...phases("drain"),
						{ label: "Discord", tasks: [() => this.destroy()] },
						...phases("cleanup"),
					],
					{
						budgetMs: this.custom.shutdownTimeoutMs,
						onError: (name, error) => {
							void this.reportError(error, { type: "shutdown", name });
						},
					},
				);
			} finally {
				// Even an exhausted hook budget must initiate gateway teardown.
				void this.destroy().catch((error) =>
					this.reportError(error, { type: "shutdown", name: "Discord" }),
				);
				this.shutdownHooks.length = 0;
			}
		});
		this.stopController.abort();
		this.detachEvents();
		return this.killPromise;
	}

	private detachEvents(): void {
		for (const detach of this.boundEvents.values()) detach();
		this.boundEvents.clear();
		this.components.events.clear();
		this.registeredEvents.clear();
	}

	/** Immediate Discord teardown. Use `kill` to also run application cleanup hooks. */
	public override destroy(): Promise<void> {
		if (this.destroyPromise) return this.destroyPromise;
		this.destroyPromise = Promise.resolve().then(() => super.destroy());
		this.stopController.abort();
		this.detachEvents();
		if (container.client === this) Reflect.deleteProperty(container, "client");
		return this.destroyPromise;
	}

	/** Cache and process memory statistics, without forcing GC or starting a timer. */
	public getStats(): DiscordClientStats {
		return {
			ready: this.isReady(),
			uptime: this.uptime,
			ping: this.ws.ping,
			memory: process.memoryUsage(),
			cache: {
				guilds: this.guilds.cache.size,
				users: this.users.cache.size,
				channels: this.channels.cache.size,
				members: this.guilds.cache.reduce(
					(total, guild) => total + guild.members.cache.size,
					0,
				),
				presences: this.guilds.cache.reduce(
					(total, guild) => total + guild.presences.cache.size,
					0,
				),
				messages: this.channels.cache.reduce(
					(total, channel) =>
						total + ("messages" in channel ? channel.messages.cache.size : 0),
					0,
				),
			},
			commands: this.commands.size,
			events: this.boundEvents.size,
		};
	}
}
