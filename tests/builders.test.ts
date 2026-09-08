import { describe, expect, test } from "bun:test";
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { DiscordCommand, DiscordEvent, DiscordPagination } from "../src";

describe("DiscordCommand", () => {
	test("exposes the data, metadata and handlers it was given", async () => {
		const data = new SlashCommandBuilder()
			.setName("ping")
			.setDescription("Pong.");
		let executed = false;

		const command = new DiscordCommand({
			data,
			metadata: { category: "misc" },
			execute: async () => {
				executed = true;
			},
		});

		expect(command.data).toBe(data);
		expect(command.metadata).toEqual({ category: "misc" });
		expect(command.autocomplete).toBeUndefined();

		await command.execute({} as never, {} as never);
		expect(executed).toBe(true);
	});
});

describe("DiscordEvent", () => {
	test("defaults once to false", () => {
		const event = new DiscordEvent({
			type: "client",
			name: "messageCreate",
			method: () => {},
		});

		expect(event.type).toBe("client");
		expect(event.name).toBe("messageCreate");
		expect(event.once).toBe(false);
	});

	test("keeps an explicit once", () => {
		const event = new DiscordEvent({
			type: "client",
			name: "clientReady",
			once: true,
			method: () => {},
		});

		expect(event.once).toBe(true);
	});
});

describe("DiscordPagination", () => {
	const entries = Array.from({ length: 12 }, (_, i) => `entry ${i + 1}`);

	test("DATA and BUTTONS are distinct sentinels", () => {
		expect(DiscordPagination.DATA).not.toBe(DiscordPagination.BUTTONS);
		expect(typeof DiscordPagination.DATA).toBe("symbol");
	});

	test("rejects a non-positive entriesPerPage", () => {
		expect(
			() =>
				new DiscordPagination(entries, {
					type: "embed",
					embed: new EmbedBuilder(),
					entriesPerPage: 0,
				}),
		).toThrow(RangeError);
	});

	test("rejects a non-integer entriesPerPage", () => {
		expect(
			() =>
				new DiscordPagination(entries, {
					type: "embed",
					embed: new EmbedBuilder(),
					entriesPerPage: 2.5,
				}),
		).toThrow(RangeError);
	});

	test("accepts a container layout containing both sentinels", () => {
		expect(
			() =>
				new DiscordPagination(entries, {
					type: "container",
					layout: [
						"# Title",
						DiscordPagination.DATA,
						DiscordPagination.BUTTONS,
					],
					accentColor: 0x5865f2,
				}),
		).not.toThrow();
	});

	test("accepts an empty list", () => {
		expect(
			() =>
				new DiscordPagination([], { type: "embed", embed: new EmbedBuilder() }),
		).not.toThrow();
	});
});
