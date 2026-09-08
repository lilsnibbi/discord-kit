import type {
	AutocompleteInteraction,
	ChatInputCommandInteraction,
	Client,
	ContextMenuCommandBuilder,
	ContextMenuCommandInteraction,
	SlashCommandBuilder,
	SlashCommandOptionsOnlyBuilder,
	SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

/** Any builder discord.js accepts as an application command definition. */
export type CommandData =
	| SlashCommandBuilder
	| SlashCommandOptionsOnlyBuilder
	| SlashCommandSubcommandsOnlyBuilder
	| ContextMenuCommandBuilder;

/** Interactions a command's `execute` handler can receive. */
export type CommandInteraction =
	| ChatInputCommandInteraction
	| ContextMenuCommandInteraction;

/**
 * Arbitrary per-command data, empty by default.
 *
 * Augment it via module declaration to give your own fields types across every
 * command in the project.
 *
 * @example
 * ```ts
 * declare module "@lilsnibbi/discord-kit" {
 *   interface DiscordCommandMetadata {
 *     cooldown?: number;
 *     category?: string;
 *   }
 * }
 * ```
 */
export interface DiscordCommandMetadata extends Record<string, unknown> {}

/** Constructor options for {@link DiscordCommand}. */
export interface DiscordCommandOptions<C extends Client = Client> {
	/** The slash or context menu command definition. */
	data: CommandData;
	/** Consumer-defined data — see {@link DiscordCommandMetadata}. */
	metadata: DiscordCommandMetadata;
	/** Runs when the command is invoked. */
	execute: (client: C, interaction: CommandInteraction) => void | Promise<void>;
	/** Runs when an option with autocomplete enabled is focused. */
	autocomplete?: (
		client: C,
		interaction: AutocompleteInteraction,
	) => void | Promise<void>;
}

/**
 * A discord.js slash or context menu command bundled with its handlers.
 *
 * Holding the definition and its handlers together lets a command loader read
 * `data` for registration and call `execute` for dispatch without a separate
 * lookup table.
 *
 * @typeParam C - The bot's `Client` type, forwarded to every handler.
 *
 * @example
 * ```ts
 * export default new DiscordCommand({
 *   data: new SlashCommandBuilder().setName("ping").setDescription("Pong."),
 *   metadata: {},
 *   execute: async (_client, interaction) => {
 *     await interaction.reply("Pong!");
 *   },
 * });
 * ```
 */
export class DiscordCommand<C extends Client = Client> {
	/** The slash or context menu command definition. */
	public readonly data: CommandData;
	/** Runs when the command is invoked. */
	public readonly execute: (
		client: C,
		interaction: CommandInteraction,
	) => void | Promise<void>;
	/** Runs when an option with autocomplete enabled is focused. */
	public readonly autocomplete?: (
		client: C,
		interaction: AutocompleteInteraction,
	) => void | Promise<void>;
	/** Consumer-defined data — see {@link DiscordCommandMetadata}. */
	public metadata: DiscordCommandMetadata;

	constructor(options: DiscordCommandOptions<C>) {
		this.data = options.data;
		this.metadata = options.metadata;
		this.execute = options.execute;
		this.autocomplete = options.autocomplete;
	}
}
