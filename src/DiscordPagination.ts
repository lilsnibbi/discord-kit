import { randomUUIDv7 } from "bun";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type ChannelSelectMenuBuilder,
	type ChatInputCommandInteraction,
	ComponentType,
	ContainerBuilder,
	EmbedBuilder,
	type FileBuilder,
	LabelBuilder,
	type MediaGalleryBuilder,
	type MentionableSelectMenuBuilder,
	type Message,
	ModalBuilder,
	type RoleSelectMenuBuilder,
	type SectionBuilder,
	type SeparatorBuilder,
	type StringSelectMenuBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
	type UserSelectMenuBuilder,
} from "discord.js";

/** Any of the five select menu builders discord.js ships. */
export type AnySelectMenuBuilder =
	| StringSelectMenuBuilder
	| UserSelectMenuBuilder
	| RoleSelectMenuBuilder
	| ChannelSelectMenuBuilder
	| MentionableSelectMenuBuilder;

/** An action row holding any interactive message component. */
export type MessageActionRow = ActionRowBuilder<
	ButtonBuilder | AnySelectMenuBuilder
>;

/** Interactions a pagination can attach itself to. */
export type PaginationInteraction =
	| ButtonInteraction
	| ChatInputCommandInteraction;

/** Anything a pagination can be sent in reply to. */
export type PaginationTarget = PaginationInteraction | Message;

/** Marks where the navigation buttons render within a layout. */
export const BUTTONS_SYMBOL: unique symbol = Symbol("pagination-buttons");

/** Marks where the current page's entries render within a layout. */
export const DATA_SYMBOL: unique symbol = Symbol("pagination-data");

/** A layout component that renders identically on every page. */
export type PaginationStaticComponent =
	| TextDisplayBuilder
	| SectionBuilder
	| SeparatorBuilder
	| FileBuilder
	| MediaGalleryBuilder
	| MessageActionRow;

/**
 * An entry in a container layout: a static component, a bare string (shorthand
 * for a `TextDisplayBuilder`), or one of the two placement sentinels.
 */
export type PaginationInput =
	| string
	| PaginationStaticComponent
	| typeof BUTTONS_SYMBOL
	| typeof DATA_SYMBOL;

/** A layout entry after the sentinels have been resolved. */
type PaginationComponent =
	| { kind: "buttons" }
	| { kind: "data" }
	| { kind: "static"; component: PaginationStaticComponent };

/** Appearance of a single navigation button. */
export interface PaginationButtonConfig {
	/** Replaces the default label. */
	label?: string;
	/** Adds an emoji alongside the label. */
	emoji?: string;
	/** Replaces the default `Secondary` style. */
	style?: ButtonStyle;
}

/** Per-button appearance overrides. */
export interface PaginationButtonOptions {
	/** Jump to the first page. Only rendered when `showSkipButtons` is set. */
	first?: PaginationButtonConfig;
	/** Step back one page. */
	back?: PaginationButtonConfig;
	/** Step forward one page. */
	next?: PaginationButtonConfig;
	/** Jump to the last page. Only rendered when `showSkipButtons` is set. */
	last?: PaginationButtonConfig;
	/** Opens the "jump to page" modal. Defaults to a `current/total` counter. */
	jump?: PaginationButtonConfig;
}

/** Options shared by every pagination mode. */
export interface PaginationBaseOptions {
	/** Entries shown per page. Defaults to `5`. */
	entriesPerPage?: number;
	/** Literal substrings replaced in rendered page content. */
	replacements?: Record<string, string>;
	/** Send the reply as ephemeral. Ignored for message targets. */
	ephemeral?: boolean;
	/** Idle timeout in milliseconds before the buttons disable. Defaults to `60_000`. */
	idleTimeout?: number;
	/** Per-button appearance overrides. */
	buttons?: PaginationButtonOptions;
	/** Render the first/last skip buttons. Defaults to `false`. */
	showSkipButtons?: boolean;
	/** Called once the collector stops, after the buttons are disabled. */
	onEnd?: (interaction?: PaginationInteraction) => void | Promise<void>;
}

/**
 * Options for container mode: a Components V2 layout built from a
 * `ContainerBuilder`, sent with the `IsComponentsV2` message flag.
 */
export interface PaginationContainerOptions extends PaginationBaseOptions {
	/** Selects container mode. */
	type: "container";
	/**
	 * The page template. Include {@link DiscordPagination.DATA} and
	 * {@link DiscordPagination.BUTTONS} to place the entries and the navigation
	 * buttons; everything else renders as-is on every page.
	 */
	layout: PaginationInput[];
	/** Accent colour of the container's left edge. */
	accentColor?: number;
	/** Render the container behind a spoiler. */
	spoiler?: boolean;
}

/**
 * Options for embed mode: a standard `EmbedBuilder` with the navigation buttons
 * in an action row beneath it.
 */
export interface PaginationEmbedOptions extends PaginationBaseOptions {
	/**
	 * The page template. Its `description` and `footer` are overwritten each
	 * page with the entries and the page counter respectively.
	 */
	embed: EmbedBuilder;
	/** Selects embed mode. */
	type: "embed";
}

/** Every pagination mode, discriminated by `type`. */
export type PaginationOptions =
	| PaginationContainerOptions
	| PaginationEmbedOptions;

/** Resolved mode, holding only the fields that mode actually uses. */
type PaginationMode =
	| {
			type: "container";
			layout: PaginationComponent[];
			accentColor?: number;
			spoiler?: boolean;
	  }
	| { type: "embed"; embed: EmbedBuilder };

const ALLOWED_MENTIONS = { parse: [] as const, repliedUser: false };
const EMPTY_CONTENT = "No data to show";
const MODAL_TIMEOUT = 60_000;

/** Narrows a target to a `Message`; only interactions can be deferred. */
function isMessageTarget(target: PaginationTarget): target is Message {
	return !("deferReply" in target);
}

/**
 * A button-driven paginator for long lists, in either Components V2 container
 * mode or classic embed mode.
 *
 * Navigation state lives on the instance, so one paginator drives one message.
 * The collector is scoped to that message and to the user who triggered it, and
 * every button carries a per-instance id prefix, so several paginators can run
 * in the same channel without colliding. When the idle timeout elapses the
 * buttons are disabled rather than removed.
 *
 * @example Container mode
 * ```ts
 * await new DiscordPagination(entries, {
 *   type: "container",
 *   layout: [
 *     "# Leaderboard",
 *     new SeparatorBuilder(),
 *     DiscordPagination.DATA,
 *     new SeparatorBuilder(),
 *     DiscordPagination.BUTTONS,
 *   ],
 *   accentColor: 0x5865f2,
 * }).send(interaction);
 * ```
 *
 * @example Embed mode
 * ```ts
 * await new DiscordPagination(entries, {
 *   type: "embed",
 *   embed: new EmbedBuilder().setTitle("Leaderboard").setColor(0x5865f2),
 *   showSkipButtons: true,
 * }).send(interaction);
 * ```
 */
export class DiscordPagination {
	/** Sentinel marking where the navigation buttons render. */
	static readonly BUTTONS: typeof BUTTONS_SYMBOL = BUTTONS_SYMBOL;
	/** Sentinel marking where the current page's entries render. */
	static readonly DATA: typeof DATA_SYMBOL = DATA_SYMBOL;

	private readonly list: string[];
	private readonly mode: PaginationMode;
	private readonly entriesPerPage: number;
	private readonly totalPages: number;
	private readonly replacements?: Record<string, string>;
	private readonly ephemeral: boolean;
	private readonly idleTimeout: number;
	private readonly buttons?: PaginationButtonOptions;
	private readonly showSkipButtons: boolean;
	private readonly onEnd?: (
		interaction?: PaginationInteraction,
	) => void | Promise<void>;

	/** Prefix isolating this instance's button ids from any other paginator's. */
	private readonly prefix: string;

	private currentIndex = 0;
	private ended = false;
	private interaction?: PaginationInteraction;
	private replyMessage?: Message;

	/**
	 * @param list - The entries to paginate, one per line.
	 * @param options - See {@link PaginationOptions}.
	 * @throws {RangeError} If `entriesPerPage` is not a positive integer.
	 */
	constructor(list: string[], options: PaginationOptions) {
		const {
			entriesPerPage = 5,
			replacements,
			ephemeral = false,
			idleTimeout = 60_000,
			buttons,
			showSkipButtons = false,
			onEnd,
		} = options;

		if (!Number.isInteger(entriesPerPage) || entriesPerPage <= 0) {
			throw new RangeError("entriesPerPage must be a positive integer");
		}

		this.list = list;
		this.entriesPerPage = entriesPerPage;
		this.totalPages = Math.ceil(list.length / entriesPerPage);
		this.replacements = replacements;
		this.ephemeral = ephemeral;
		this.idleTimeout = idleTimeout;
		this.buttons = buttons;
		this.showSkipButtons = showSkipButtons;
		this.onEnd = onEnd;
		this.prefix = `~PAGINATION_${randomUUIDv7()}_`;

		this.mode =
			options.type === "container"
				? {
						type: "container",
						layout: options.layout.map((input) => normalize(input)),
						accentColor: options.accentColor,
						spoiler: options.spoiler,
					}
				: { type: "embed", embed: options.embed };
	}

	/**
	 * Sends the first page and starts listening for button presses.
	 *
	 * An empty list short-circuits to a placeholder message with no collector.
	 *
	 * @param target - The interaction or message to reply to. Only the user who
	 * triggered it can drive the resulting buttons.
	 */
	public async send(target: PaginationTarget): Promise<void> {
		if (!this.list.length) return this.sendEmpty(target);

		const userId = isMessageTarget(target) ? target.author.id : target.user.id;

		if (isMessageTarget(target)) {
			this.replyMessage = await target.reply(this.buildPayload());
		} else {
			this.interaction = target;

			if (!target.replied && !target.deferred) {
				const response = await target
					.deferReply({
						withResponse: true,
						flags: this.ephemeral ? ["Ephemeral"] : [],
					})
					.catch(() => null);
				this.replyMessage =
					response?.resource?.message ??
					(await target.fetchReply().catch(() => undefined));
			} else {
				this.replyMessage = await target.fetchReply().catch(() => undefined);
			}

			await this.render();
		}

		if (!this.replyMessage) return;

		const collector = this.replyMessage.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: this.idleTimeout,
		});

		collector.on("collect", async (button) => {
			// Prefix first: a static action row in the layout shares this
			// message, and its buttons belong to the consumer's collector.
			if (!button.customId.startsWith(this.prefix)) return;
			if (button.user.id !== userId) return void button.deferUpdate();

			this.ended = false;
			collector.resetTimer();

			const isJump = button.customId === `${this.prefix}info`;

			if (isJump) {
				await this.handlePageJump(button);
			} else if (button.customId === `${this.prefix}first`) {
				this.currentIndex = 0;
			} else if (button.customId === `${this.prefix}last`) {
				this.currentIndex = this.lastIndex;
			} else {
				const step =
					button.customId === `${this.prefix}back`
						? -this.entriesPerPage
						: this.entriesPerPage;
				this.currentIndex = Math.max(
					0,
					Math.min(this.currentIndex + step, this.lastIndex),
				);
			}

			if (!isJump) await button.deferUpdate().catch(() => {});

			await this.render();
		});

		collector.on("end", async () => {
			this.ended = true;
			await this.render();
			await this.onEnd?.(this.interaction);
		});
	}

	/** Index of the first entry on the last page. */
	private get lastIndex(): number {
		return (this.totalPages - 1) * this.entriesPerPage;
	}

	/** Zero-based index of the page currently displayed. */
	private get page(): number {
		return Math.floor(this.currentIndex / this.entriesPerPage);
	}

	/** The current page's entries, joined and with replacements applied. */
	private pageContent(): string {
		const start = this.page * this.entriesPerPage;
		const content = this.list
			.slice(start, start + this.entriesPerPage)
			.join("\n");

		if (!this.replacements) return content;

		return Object.entries(this.replacements).reduce(
			(acc, [key, value]) => acc.replaceAll(key, () => value),
			content,
		);
	}

	/** Replies with a placeholder when there is nothing to paginate. */
	private async sendEmpty(target: PaginationTarget): Promise<void> {
		const body =
			this.mode.type === "container"
				? {
						components: [
							new ContainerBuilder().addTextDisplayComponents(
								new TextDisplayBuilder().setContent(EMPTY_CONTENT),
							),
						],
					}
				: {
						embeds: [
							new EmbedBuilder(this.mode.embed.toJSON()).setDescription(
								EMPTY_CONTENT,
							),
						],
					};

		if (isMessageTarget(target)) {
			await target
				.reply(
					"components" in body
						? {
								...body,
								flags: ["IsComponentsV2"] as const,
								allowedMentions: ALLOWED_MENTIONS,
							}
						: { ...body, allowedMentions: ALLOWED_MENTIONS },
				)
				.catch(() => {});
			return;
		}

		if (target.deferred || target.replied) {
			await target
				.editReply({
					...body,
					...("components" in body
						? { flags: ["IsComponentsV2"] as const }
						: {}),
					allowedMentions: ALLOWED_MENTIONS,
				})
				.catch(() => {});
			return;
		}

		await target
			.reply(
				"components" in body
					? {
							...body,
							flags: this.ephemeral
								? (["Ephemeral", "IsComponentsV2"] as const)
								: (["IsComponentsV2"] as const),
							allowedMentions: ALLOWED_MENTIONS,
						}
					: {
							...body,
							flags: this.ephemeral ? (["Ephemeral"] as const) : ([] as const),
							allowedMentions: ALLOWED_MENTIONS,
						},
			)
			.catch(() => {});
	}

	/** Builds the message payload for the current page in the active mode. */
	private buildPayload() {
		const mode = this.mode;

		if (mode.type === "embed") {
			return {
				embeds: [
					new EmbedBuilder(mode.embed.toJSON())
						.setDescription(this.pageContent())
						.setFooter({ text: `Page ${this.page + 1}/${this.totalPages}` }),
				],
				components: [this.buildButtonRow()],
				allowedMentions: ALLOWED_MENTIONS,
			};
		}

		return {
			components: [
				new ContainerBuilder({
					components: mode.layout.map((entry) => {
						switch (entry.kind) {
							case "buttons":
								return this.buildButtonRow().toJSON();
							case "data":
								return new TextDisplayBuilder()
									.setContent(this.pageContent())
									.toJSON();
							default:
								return entry.component.toJSON();
						}
					}),
					accent_color: mode.accentColor,
					spoiler: mode.spoiler,
				}),
			],
			flags: ["IsComponentsV2"] as const,
			allowedMentions: ALLOWED_MENTIONS,
		};
	}

	/** Builds one navigation button. */
	private button(
		id: string,
		defaultLabel: string,
		config: PaginationButtonConfig | undefined,
		disabled: boolean,
	): ButtonBuilder {
		const button = new ButtonBuilder()
			.setCustomId(`${this.prefix}${id}`)
			.setLabel(config?.label ?? defaultLabel)
			.setStyle(config?.style ?? ButtonStyle.Secondary)
			.setDisabled(disabled);

		if (config?.emoji) button.setEmoji(config.emoji);

		return button;
	}

	/** Builds the navigation row for the current page. */
	private buildButtonRow(): ActionRowBuilder<ButtonBuilder> {
		const atStart = this.ended || this.currentIndex === 0;
		const atEnd =
			this.ended || this.currentIndex + this.entriesPerPage >= this.list.length;

		const row = new ActionRowBuilder<ButtonBuilder>();

		if (this.showSkipButtons) {
			row.addComponents(
				this.button("first", "<<", this.buttons?.first, atStart),
			);
		}

		row.addComponents(
			this.button("back", "<", this.buttons?.back, atStart),
			this.button(
				"info",
				`${this.page + 1}/${this.totalPages}`,
				this.buttons?.jump,
				this.ended || this.totalPages === 1,
			),
			this.button("forward", ">", this.buttons?.next, atEnd),
		);

		if (this.showSkipButtons) {
			row.addComponents(this.button("last", ">>", this.buttons?.last, atEnd));
		}

		return row;
	}

	/** Prompts for a page number via a modal and jumps to it. */
	private async handlePageJump(button: ButtonInteraction): Promise<void> {
		const modal = new ModalBuilder()
			.setCustomId(`${this.prefix}modal`)
			.setTitle("Jump to page")
			.addLabelComponents(
				new LabelBuilder()
					.setLabel("Input a page number")
					.setTextInputComponent(
						new TextInputBuilder()
							.setCustomId(`${this.prefix}number`)
							.setRequired(true)
							.setMinLength(1)
							.setStyle(TextInputStyle.Short),
					),
			);

		await button.showModal(modal).catch(() => {});

		const submission = await button
			.awaitModalSubmit({
				filter: (i) => i.customId === `${this.prefix}modal`,
				time: MODAL_TIMEOUT,
			})
			.catch(() => null);

		if (!submission) return;

		const pageNumber = Number(
			submission.fields.getTextInputValue(`${this.prefix}number`),
		);

		if (
			!Number.isInteger(pageNumber) ||
			pageNumber < 1 ||
			pageNumber > this.totalPages
		) {
			await submission
				.reply({
					content: `Invalid page! Choose a number between **1** and **${this.totalPages}**.`,
					flags: ["Ephemeral"],
					allowedMentions: ALLOWED_MENTIONS,
				})
				.catch(() => null);
			return;
		}

		await submission.deferUpdate().catch(() => null);
		this.currentIndex = (pageNumber - 1) * this.entriesPerPage;
	}

	/** Pushes the current page to the already-sent message. */
	private async render(): Promise<void> {
		try {
			const payload = this.buildPayload();

			if (this.interaction) {
				await this.interaction.editReply(payload);
			} else if (this.replyMessage) {
				await this.replyMessage.edit(payload);
			}
		} catch (error) {
			// The message was deleted while the collector was still running.
			if (!(error as Error).message.includes("Unknown Message")) {
				console.error("Failed to render pagination:", error);
			}
		}
	}
}

/** Resolves a layout entry to its internal representation. */
function normalize(input: PaginationInput): PaginationComponent {
	if (input === BUTTONS_SYMBOL) return { kind: "buttons" };
	if (input === DATA_SYMBOL) return { kind: "data" };
	if (typeof input === "string") {
		return {
			kind: "static",
			component: new TextDisplayBuilder().setContent(input),
		};
	}
	return { kind: "static", component: input };
}
