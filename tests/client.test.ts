import { beforeEach, describe, expect, test } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import {
	container,
	DiscordClient,
	DiscordCommand,
	DiscordEvent,
	getClient,
} from "../src";

const makeClient = (requiredEnvs: string[] = []) =>
	new DiscordClient({
		intents: [],
		custom: {
			logger: { name: "test", colors: false },
			requiredEnvs,
			root: import.meta.dir,
			botToken: "not-a-real-token",
		},
	});

describe("DiscordClient", () => {
	let client: DiscordClient;

	beforeEach(() => {
		client = makeClient();
	});

	test("publishes itself to the container", () => {
		expect(container.client).toBe(client);
		expect(getClient()).toBe(client);
	});

	test("starts with an empty registry", () => {
		expect(client.components.events.size).toBe(0);
		expect(client.components.commands.size).toBe(0);
	});

	test("registers an event under its source", () => {
		const event = new DiscordEvent({
			type: "client",
			name: "messageCreate",
			method: () => {},
		});

		client.registerPiece(event);

		expect(client.components.events.has(event)).toBe(true);
		expect(client.components.commands.size).toBe(0);
	});

	test("registers a command under its data name", () => {
		const command = new DiscordCommand({
			data: new SlashCommandBuilder().setName("ping").setDescription("Pong."),
			metadata: {},
			execute: () => {},
		});

		client.registerPiece(command);

		expect(client.components.commands.get("ping")).toBe(command);
		expect(client.components.events.size).toBe(0);
	});

	test("a second command of the same name replaces the first", () => {
		const data = new SlashCommandBuilder()
			.setName("ping")
			.setDescription("Pong.");
		const first = new DiscordCommand({ data, metadata: {}, execute: () => {} });
		const second = new DiscordCommand({
			data,
			metadata: {},
			execute: () => {},
		});

		client.registerPiece(first);
		client.registerPiece(second);

		expect(client.components.commands.size).toBe(1);
		expect(client.components.commands.get("ping")).toBe(second);
	});

	test("login rejects before any network call when an env var is missing", async () => {
		const guarded = makeClient(["DEFINITELY_NOT_SET_lilsnibbi_utils"]);

		await expect(guarded.login()).rejects.toThrow(
			"Missing env vars: DEFINITELY_NOT_SET_lilsnibbi_utils",
		);
		expect(guarded.components.events.size).toBe(0);
	});
});
