import { Client, type ClientOptions } from "discord.js";
import { Logger, type LoggerOptions } from "@lilsnibbi/logger";
import { DiscordCommand } from "./DiscordCommand";
import { type AnyDiscordEvent, DiscordEvent } from "./DiscordEvent";
import { container } from "./container";

/** The bot-specific half of {@link DiscordClientOptions}. */
export interface DiscordClientCustomOptions {
	/** Configuration for the client's {@link Logger}. */
	logger: LoggerOptions;
	/** Environment variables that must be set before {@link DiscordClient.login}. */
	requiredEnvs: string[];
	/** Absolute path to the project root, for resolving module directories. */
	root: string;
	/** The bot token, used as the default argument to `login`. */
	botToken: string;
	/** Guild that guild-scoped command registration targets, if any. */
	operatingGuildId?: string;
}

/**
 * Constructor options for {@link DiscordClient} — every discord.js
 * `ClientOptions` field plus a `custom` bag of this client's own settings.
 */
export interface DiscordClientOptions extends ClientOptions {
	/** Settings specific to this client rather than to discord.js. */
	custom: DiscordClientCustomOptions;
}

/** The pieces a {@link DiscordClient} has been given. */
export interface DiscordClientComponents {
	/** Events awaiting attachment; emptied as `login` binds each listener. */
	events: Set<AnyDiscordEvent<DiscordClient>>;
	/** Commands by their `data.name`. */
	commands: Map<string, DiscordCommand<DiscordClient>>;
}

/**
 * A discord.js `Client` that carries its own logger and piece registry, and
 * publishes itself to the {@link container} so any module can reach it.
 *
 * Pieces are handed to {@link DiscordClient.registerPiece} before `login`,
 * which validates the environment and attaches every registered listener.
 *
 * @example
 * ```ts
 * const client = new DiscordClient({
 *   intents: [GatewayIntentBits.Guilds],
 *   custom: {
 *     logger: { name: "bot" },
 *     requiredEnvs: ["BOT_TOKEN"],
 *     root: import.meta.dir,
 *     botToken: Bun.env.BOT_TOKEN as string,
 *   },
 * });
 *
 * // Piece files self-register through the container, so they must be imported
 * // dynamically — a static import is hoisted above the line above.
 * await import("./events/ready");
 * await client.login();
 * ```
 */
export class DiscordClient extends Client {
	/** The client's logger, built from `custom.logger`. */
	public readonly log: Logger;
	/** The settings this client was constructed with. */
	public readonly custom: DiscordClientCustomOptions;
	/** The pieces registered so far. */
	public readonly components: DiscordClientComponents;

	constructor(ops: DiscordClientOptions) {
		super(ops);
		this.custom = ops.custom;

		// Assign
		this.log = new Logger({ ...this.custom.logger });
		this.components = {
			events: new Set(),
			commands: new Map(),
		};

		container.client = this;
	}

	/**
	 * Throws unless every name in `custom.requiredEnvs` is set.
	 *
	 * @throws {Error} If any required variable is missing.
	 */
	private validateEnv(): void {
		const missing = this.custom.requiredEnvs.filter((key) => !Bun.env[key]);
		if (missing.length) {
			throw new Error(`Missing env vars: ${missing.join(", ")}`);
		}
	}

	/**
	 * Validates the environment, attaches every registered event, then logs in.
	 *
	 * @param token - The bot token. Defaults to `custom.botToken`.
	 * @returns The token that was used, as discord.js reports it.
	 * @throws {Error} If a required environment variable is missing.
	 */
	public override async login(token = this.custom.botToken): Promise<string> {
		this.validateEnv();
		this.loadModules();

		return await super.login(token);
	}

	/**
	 * Adds a piece to the registry.
	 *
	 * One overload per event source rather than a single union parameter: a
	 * union as the contextual type stops an inline `new DiscordEvent({ ... })`
	 * from inferring its event name, which is what types the handler's
	 * arguments.
	 *
	 * @param piece - The event or command to register.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: see AnyDiscordEvent
	public registerPiece(piece: DiscordEvent<"client", any, DiscordClient>): void;
	// biome-ignore lint/suspicious/noExplicitAny: see AnyDiscordEvent
	public registerPiece(piece: DiscordEvent<"rest", any, DiscordClient>): void;
	// biome-ignore lint/suspicious/noExplicitAny: see AnyDiscordEvent
	public registerPiece(piece: DiscordEvent<"custom", any, DiscordClient>): void;
	public registerPiece(piece: DiscordCommand<DiscordClient>): void;
	public registerPiece(
		piece: AnyDiscordEvent<DiscordClient> | DiscordCommand<DiscordClient>,
	): void {
		if (piece instanceof DiscordEvent) {
			this.components.events.add(piece);
			return;
		}

		if (piece instanceof DiscordCommand) {
			this.components.commands.set(piece.data.name, piece);
			return;
		}

		// Unreachable for a typed caller, but a JavaScript one can get here.
		const label = (piece as object)?.constructor?.name ?? String(piece);
		this.log.alert(`Unsupported piece loaded. Piece: ${label}`, {
			box: {
				topRight: "PieceLoader",
			},
		});
	}

	/**
	 * Attaches every registered event to its emitter, removing each from
	 * `components.events` as it is bound so a second call cannot double-listen.
	 */
	private loadModules(): void {
		for (const event of this.components.events.values()) {
			const bind = event.once ? "once" : "on";
			const listener = (...args: unknown[]) => event.method(this, ...args);

			switch (event.type) {
				case "rest":
					this.rest[bind](event.name, listener);
					break;
				case "client":
				case "custom":
					this[bind](event.name, listener);
					break;
			}

			this.components.events.delete(event);
		}
	}
}
