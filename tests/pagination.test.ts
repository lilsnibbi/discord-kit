import { describe, expect, mock, test } from "bun:test";
import {
	EmbedBuilder,
	type ChatInputCommandInteraction,
	type Message,
} from "discord.js";
import { DiscordPagination } from "../src";

describe("pagination replies", () => {
	for (const state of ["deferred", "replied"] as const) {
		for (const type of ["embed", "container"] as const) {
			test(`edits an empty ${type} result when already ${state}`, async () => {
				const reply = mock(async () => {});
				const editReply = mock(async (_payload: unknown) => {});
				const target = {
					deferReply: mock(),
					deferred: state === "deferred",
					replied: state === "replied",
					reply,
					editReply,
				};
				const pagination = new DiscordPagination(
					[],
					type === "embed"
						? { type, embed: new EmbedBuilder() }
						: { type, layout: [DiscordPagination.DATA] },
				);
				await pagination.send(target as unknown as ChatInputCommandInteraction);
				expect(editReply).toHaveBeenCalledTimes(1);
				expect(reply).not.toHaveBeenCalled();
				const payload = editReply.mock.calls[0]?.[0] as { flags?: string[] };
				expect(payload.flags ?? []).not.toContain("Ephemeral");
			});
		}
	}

	test("treats replacement values as literal text", async () => {
		const reply = mock(async (_payload: unknown) => ({
			createMessageComponentCollector: () => ({ on() {} }),
		}));
		const target = { author: { id: "owner" }, reply };
		await new DiscordPagination(["TOKEN"], {
			type: "embed",
			embed: new EmbedBuilder(),
			replacements: { TOKEN: "$& $$ $'" },
		}).send(target as unknown as Message);
		const payload = reply.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
		expect(payload.embeds[0]?.toJSON().description).toBe("$& $$ $'");
	});
});
