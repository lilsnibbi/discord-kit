import { expect, test } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import { DiscordClient, DiscordCommand, DiscordEvent } from "../src";

test("subclass callbacks remain contravariant", () => {
	class Bot extends DiscordClient {
		public service(): void {}
	}

	const command = new DiscordCommand<Bot>({
		data: new SlashCommandBuilder().setName("ping").setDescription("Pong"),
		metadata: {},
		execute: (client) => client.service(),
	});
	const event = new DiscordEvent<"client", "debug", Bot>({
		type: "client",
		name: "debug",
		method: (client) => client.service(),
	});
	const acceptCommand = (_piece: DiscordCommand<DiscordClient>) => {};
	const acceptEvent = (
		_piece: DiscordEvent<"client", "debug", DiscordClient>,
	) => {};

	// @ts-expect-error A plain client cannot satisfy a subclass command callback.
	acceptCommand(command);
	// @ts-expect-error A plain client cannot satisfy a subclass event callback.
	acceptEvent(event);
	expect(command).toBeDefined();
	expect(event).toBeDefined();
});
