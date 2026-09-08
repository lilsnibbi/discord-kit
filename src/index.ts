/**
 * Entry point for `@lilsnibbi/discord-kit`.
 *
 * Requires the `discord.js` peer dependency. The client publishes itself to
 * `container`, and the command, event and pagination structures are the pieces
 * a bot registers against it.
 */
export * from "./container";
export * from "./DiscordClient";
export * from "./DiscordCommand";
export * from "./DiscordEvent";
export * from "./DiscordPagination";
