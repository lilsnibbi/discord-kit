import type { DiscordClient } from "./DiscordClient";

/**
 * The shared dependency bag, reachable from any module without threading the
 * client through every constructor.
 *
 * Augment it via module declaration to register your own singletons alongside
 * the client.
 *
 * @example
 * ```ts
 * declare module "@lilsnibbi/discord-kit" {
 *   interface Container {
 *     db: Database;
 *   }
 * }
 * ```
 */
export interface Container {
	/** The live client, assigned by the `DiscordClient` constructor. */
	client: DiscordClient;
}

/**
 * The process-wide {@link Container}.
 *
 * It is a mutable object rather than a re-exported binding so importers always
 * read the current value, and it is empty until a `DiscordClient` is
 * constructed — reach for {@link getClient} if you need that guarded.
 *
 * @example
 * ```ts
 * import { container } from "@lilsnibbi/discord-kit";
 *
 * container.client.log.notif("ready");
 * ```
 */
export const container = {} as Container;

/**
 * Returns the active client, throwing before construction or after destruction.
 *
 * Pass a client class to also check its runtime type and retrieve subclass members.
 * @throws {Error} If no active client exists or its class does not match.
 */
export function getClient(): DiscordClient;
export function getClient<C extends DiscordClient>(
	clientType: abstract new (...args: never[]) => C,
): C;
export function getClient(
	clientType?: abstract new (...args: never[]) => DiscordClient,
): DiscordClient {
	if (!container.client) {
		throw new Error(
			"No DiscordClient has been constructed yet — the container is empty.",
		);
	}
	if (clientType && !(container.client instanceof clientType)) {
		throw new Error(
			`The active DiscordClient is not an instance of ${clientType.name}`,
		);
	}

	return container.client;
}
