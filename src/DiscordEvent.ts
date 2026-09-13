import type { Client, ClientEvents, RestEvents } from "discord.js";

/**
 * Custom events, empty by default.
 *
 * Augment it via module declaration to make your own events available to
 * {@link DiscordEvent} under `type: "custom"`.
 *
 * @example
 * ```ts
 * declare module "@lilsnibbi/discord-kit" {
 *   interface DiscordEventCustomType {
 *     myEvent: [data: string];
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: the empty shape is the extension point
export interface DiscordEventCustomType {}

/** Which discord.js emitter an event belongs to. */
export type DiscordEventSource = "client" | "rest" | "custom";

/**
 * Shown instead of `never` when `type: "custom"` is used before any custom
 * event has been declared, so autocomplete explains the missing augmentation
 * rather than offering nothing.
 */
interface NoCustomEventsDeclared {
	"augment DiscordEventCustomType to declare custom events": [];
}

/** Resolves an event source to the event map it emits. */
export type EventMap<T extends DiscordEventSource> = T extends "client"
	? ClientEvents
	: T extends "rest"
		? RestEvents
		: keyof DiscordEventCustomType extends never
			? NoCustomEventsDeclared
			: DiscordEventCustomType;

/** Resolves the listener argument tuple for a source and event name. */
export type EventArgs<
	T extends DiscordEventSource,
	K extends keyof EventMap<T>,
> = Extract<EventMap<T>[K], unknown[]>;

/** Constructor options for {@link DiscordEvent}. */
export interface DiscordEventOptions<
	T extends DiscordEventSource,
	K extends keyof EventMap<T>,
	C extends Client = Client,
> {
	/** Which emitter the event comes from. */
	type: T;
	/** The event name, checked against the map `type` selects. */
	name: K;
	/** Detach the listener after its first call. Defaults to `false`. */
	once?: boolean;
	/** Runs when the event fires. Method variance supports client subclasses. */
	method(client: C, ...args: EventArgs<T, K>): void | Promise<void>;
}

/**
 * A discord.js event listener bundled with the metadata needed to register it.
 *
 * The `type` discriminant selects the event map `name` and the handler
 * arguments are checked against, covering the gateway client, the REST manager,
 * and any events declared through {@link DiscordEventCustomType}.
 *
 * @typeParam T - The event source.
 * @typeParam K - The event name within that source's map.
 * @typeParam C - The bot's `Client` type, forwarded to the handler.
 *
 * @example
 * ```ts
 * export default new DiscordEvent({
 *   type: "client",
 *   name: "messageCreate",
 *   method: async (_client, message) => {
 *     if (!message.author.bot) await message.react("👋");
 *   },
 * });
 * ```
 */
export class DiscordEvent<
	T extends DiscordEventSource,
	K extends keyof EventMap<T> = keyof EventMap<T>,
	C extends Client = Client,
> {
	/** Which emitter the event comes from. */
	public readonly type: T;
	/** The event name. */
	public readonly name: K;
	/** Whether the listener detaches after its first call. */
	public readonly once: boolean;
	/** Runs when the event fires. */
	public readonly method: DiscordEventOptions<T, K, C>["method"];

	constructor(options: DiscordEventOptions<T, K, C>) {
		this.type = options.type;
		this.name = options.name;
		this.once = options.once ?? false;
		this.method = options.method;
	}
}

/**
 * Any event, whatever its source — the shape a registry stores.
 *
 * {@link DiscordEvent} cannot be widened by passing the union to `T`:
 * `keyof EventMap<DiscordEventSource>` is the *intersection* of the three
 * maps' keys, which is `never`, so nothing would be assignable. Naming each
 * source separately keeps `type` narrowable, and `any` for `K` collapses the
 * per-event argument tuple that would otherwise make a concrete event
 * incompatible under `strictFunctionTypes`.
 *
 * @typeParam C - The bot's `Client` type, forwarded to every handler.
 */
export type AnyDiscordEvent<C extends Client = Client> =
	// biome-ignore lint/suspicious/noExplicitAny: widening K is the point
	| DiscordEvent<"client", any, C>
	// biome-ignore lint/suspicious/noExplicitAny: widening K is the point
	| DiscordEvent<"rest", any, C>
	// biome-ignore lint/suspicious/noExplicitAny: widening K is the point
	| DiscordEvent<"custom", any, C>;
