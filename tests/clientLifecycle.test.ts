import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	Client,
	Collection,
	type Guild,
	SlashCommandBuilder,
} from "discord.js";
import {
	container,
	DiscordClient,
	type DiscordClientErrorContext,
	type DiscordClientOptions,
	DiscordCommand,
	DiscordEvent,
	getClient,
	runDiscordShutdown,
} from "../src";

declare module "../src/DiscordEvent" {
	interface DiscordEventCustomType {
		kitTest: [value: string];
	}
}

const options = (): DiscordClientOptions => ({
	intents: [],
	custom: {
		logger: { name: "test", colors: false },
		root: import.meta.dir,
		requiredEnvs: [],
		botToken: "fake",
		operatingGuildId: "guild",
		applicationId: "app",
	},
});
const clients: DiscordClient[] = [];
const directories: string[] = [];
const client = () => {
	const instance = new DiscordClient(options());
	clients.push(instance);
	return instance;
};
const command = (name = "ping") =>
	new DiscordCommand({
		data: new SlashCommandBuilder()
			.setName(name)
			.setDescription("Test command"),
		metadata: {},
		execute: () => {},
	});
const tick = () => new Promise<void>((done) => setTimeout(done, 0));

afterEach(async () => {
	mock.restore();
	await Promise.all(clients.splice(0).map((instance) => instance.destroy()));
	// Every directory was created beneath this test folder by mkdtemp.
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("typed pieces and listeners", () => {
	test("typed container access checks the requested subclass", () => {
		class Bot extends DiscordClient {
			readonly service = "available";
		}
		class Other extends DiscordClient {
			readonly other = true;
		}
		const bot = new Bot(options());
		clients.push(bot);
		expect(getClient(Bot).service).toBe("available");
		expect(() => getClient(Other)).toThrow("not an instance");
	});
	test("subclass handlers retain the client and event argument types", async () => {
		class Bot extends DiscordClient {
			readonly service = "service";
		}
		const bot = new Bot(options());
		clients.push(bot);
		const values: string[] = [];
		bot.registerPiece(
			new DiscordEvent({
				type: "client",
				name: "debug",
				method: (current, message) => {
					values.push(current.service, message.toUpperCase());
				},
			}),
		);
		bot.registerPiece(
			new DiscordEvent({
				type: "rest",
				name: "restDebug",
				method: (current, message) => {
					values.push(current.service, message);
				},
			}),
		);
		bot.registerPiece(
			new DiscordEvent({
				type: "custom",
				name: "kitTest",
				method: (current, value) => {
					values.push(current.service, value);
				},
			}),
		);
		bot.registerPiece(
			new DiscordCommand<Bot>({
				...command(),
				execute: (current) => {
					values.push(current.service);
				},
			}),
		);
		await bot.loadModules();
		bot.emit("debug", "hello");
		bot.rest.emit("restDebug", "rest");
		bot.emit("kitTest", "custom");
		await bot.commands.get("ping")?.execute(bot, {} as never);
		expect(values).toEqual([
			"service",
			"HELLO",
			"service",
			"rest",
			"service",
			"custom",
			"service",
		]);
		expect(bot.commands).toBe(bot.components.commands);
	});

	test("repeated loading and registration never duplicate listeners", async () => {
		const bot = client();
		const handler = mock(() => {});
		const event = new DiscordEvent({
			type: "client",
			name: "debug",
			method: handler,
		});
		bot.registerPiece(event);
		await Promise.all([bot.loadModules(), bot.loadModules()]);
		bot.registerPiece(event);
		bot.emit("debug", "once");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(bot.components.events.size).toBe(0);
		expect(bot.unregisterPiece(event)).toBe(true);
		bot.emit("debug", "removed");
		expect(handler).toHaveBeenCalledTimes(1);
		bot.registerPiece(event); // Late registration binds immediately.
		bot.emit("debug", "again");
		expect(handler).toHaveBeenCalledTimes(2);
	});

	test("once listeners stay consumed until explicitly unregistered", async () => {
		const bot = client();
		const handler = mock(() => {});
		const event = new DiscordEvent({
			type: "rest",
			name: "restDebug",
			once: true,
			method: handler,
		});
		bot.registerPiece(event);
		await bot.loadModules();
		bot.rest.emit("restDebug", "one");
		bot.registerPiece(event);
		await bot.loadModules();
		bot.rest.emit("restDebug", "two");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(bot.getStats().events).toBe(0);
		bot.unregisterPiece(event);
		bot.registerPiece(event);
		bot.rest.emit("restDebug", "three");
		expect(handler).toHaveBeenCalledTimes(2);
	});

	test("sync, async, and reporter failures are contained", async () => {
		class Bot extends DiscordClient {
			readonly errors: DiscordClientErrorContext[] = [];
			protected override async onError(
				_error: unknown,
				context: DiscordClientErrorContext,
			) {
				this.errors.push(context);
				throw new Error("reporter");
			}
		}
		const bot = new Bot(options());
		clients.push(bot);
		const log = spyOn(bot.log, "error").mockImplementation(() => {});
		bot.registerPiece(
			new DiscordEvent({
				type: "client",
				name: "debug",
				method: () => {
					throw new Error("sync");
				},
			}),
		);
		bot.registerPiece(
			new DiscordEvent({
				type: "rest",
				name: "restDebug",
				method: async () => {
					throw new Error("async");
				},
			}),
		);
		await bot.loadModules();
		bot.emit("debug", "x");
		bot.rest.emit("restDebug", "x");
		await tick();
		expect(bot.errors.map((context) => context.type)).toEqual([
			"event",
			"event",
		]);
		expect(log).toHaveBeenCalledTimes(2);
	});

	test("duplicate policy and unregister preserve replacements", () => {
		const bot = client();
		const first = command();
		const second = command();
		bot.registerPiece(first);
		bot.custom.duplicateCommands = "skip";
		bot.registerPiece(second);
		expect(bot.commands.get("ping")).toBe(first);
		bot.custom.duplicateCommands = "error";
		expect(() => bot.registerPiece(second)).toThrow("Duplicate command");
		bot.custom.duplicateCommands = "replace";
		bot.registerPiece(second);
		expect(bot.unregisterPiece(first)).toBe(false);
		expect(bot.commands.get("ping")).toBe(second);
		expect(bot.unregisterPiece(second)).toBe(true);
	});
});

describe("startup", () => {
	test("a real gateway-layer rejection tears down and requires a new instance", async () => {
		const bot = client();
		const connect = spyOn(
			bot.ws as unknown as { connect(): Promise<void> },
			"connect",
		).mockRejectedValue(new Error("gateway failed"));
		await expect(bot.login()).rejects.toThrow("gateway failed");
		expect(bot.isShuttingDown).toBe(true);
		await expect(bot.login()).rejects.toThrow("shutting down");
		expect(connect).toHaveBeenCalledTimes(1);
	});

	test("abort listeners can reenter kill without repeating cleanup", async () => {
		const bot = client();
		const cleanup = mock(() => {});
		bot.addShutdownHook("cleanup", cleanup);
		let reentrant: Promise<void> | undefined;
		bot.shutdownSignal.addEventListener("abort", () => {
			reentrant = bot.kill();
		});
		const pending = bot.kill();
		expect(reentrant).toBe(pending);
		await pending;
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
	test("concurrent init calls share setup and gateway login", async () => {
		class Bot extends DiscordClient {
			attempts = 0;
			protected override async setup() {
				this.attempts++;
				await tick();
			}
		}
		const bot = new Bot(options());
		clients.push(bot);
		const login = spyOn(Client.prototype, "login").mockResolvedValue("fake");
		const first = bot.init();
		expect(bot.init()).toBe(first);
		await first;
		await bot.init();
		expect(bot.attempts).toBe(1);
		expect(login).toHaveBeenCalledTimes(1);
	});

	test("setup rejection permits retry, with validation before services", async () => {
		class Bot extends DiscordClient {
			attempts = 0;
			protected override async setup() {
				if (++this.attempts === 1) throw new Error("setup failed");
			}
		}
		const bot = new Bot(options());
		clients.push(bot);
		const login = spyOn(Client.prototype, "login").mockResolvedValue("fake");
		bot.custom.requiredEnvs = ["DISCORD_KIT_MISSING_TEST_ENV"];
		await expect(bot.init()).rejects.toThrow("Missing env vars");
		expect(bot.attempts).toBe(0);
		bot.custom.requiredEnvs = [];
		await expect(bot.init()).rejects.toThrow("setup failed");
		await bot.init();
		expect(bot.attempts).toBe(2);
		expect(login).toHaveBeenCalledTimes(1);
	});

	test("shutdown during setup prevents later gateway login", async () => {
		const release = Promise.withResolvers<void>();
		class Bot extends DiscordClient {
			protected override async setup() {
				await release.promise;
			}
		}
		const bot = new Bot(options());
		clients.push(bot);
		const login = spyOn(Client.prototype, "login").mockResolvedValue("fake");
		const starting = bot.init().catch((error: unknown) => error);
		await tick();
		await bot.kill();
		release.resolve();
		expect(String(await starting)).toContain("shutting down");
		expect(login).not.toHaveBeenCalled();
		await expect(bot.init()).rejects.toThrow("shutting down");
	});

	test("login loads once, forwards token, and never registers remotely", async () => {
		const bot = client();
		const handler = mock(() => {});
		bot.registerPiece(
			new DiscordEvent({ type: "client", name: "debug", method: handler }),
		);
		const login = spyOn(Client.prototype, "login").mockImplementation(
			async () => {
				bot.emit("debug", "connected");
				return "override";
			},
		);
		const put = spyOn(bot.rest, "put").mockResolvedValue([]);
		const first = bot.login("override");
		expect(bot.login("override")).toBe(first);
		expect(await first).toBe("override");
		expect(login).toHaveBeenCalledWith("override");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(put).not.toHaveBeenCalled();
	});
});

async function fixture() {
	const root = await mkdtemp(join(import.meta.dir, ".client modules #"));
	directories.push(root);
	const entry = JSON.stringify(
		pathToFileURL(resolve(import.meta.dir, "../src/index.ts")).href,
	);
	const prefix = `import { DiscordCommand, DiscordEvent } from ${entry};\nimport { SlashCommandBuilder } from "discord.js";\n`;
	const write = async (name: string, body: string) => {
		const path = join(root, name);
		await mkdir(resolve(path, ".."), { recursive: true });
		await Bun.write(path, prefix + body);
	};
	return { root, write };
}

describe("module discovery", () => {
	test("invalid arrays are validated before any piece is registered", async () => {
		const { root, write } = await fixture();
		await write(
			"invalid.mjs",
			'export default [new DiscordCommand({ data: new SlashCommandBuilder().setName("ping").setDescription("Pong"), metadata: {}, execute() {} }), { invalid: true }];',
		);
		const bot = client();
		bot.custom.root = root;
		await expect(bot.loadModules({ patterns: ["*.mjs"] })).rejects.toThrow(
			"invalid.mjs",
		);
		expect(bot.commands.size).toBe(0);
	});

	test("a missing configured directory rejects instead of silently skipping discovery", async () => {
		const { root } = await fixture();
		const bot = client();
		bot.custom.root = root;
		await expect(
			bot.loadModules({ directory: "missing", patterns: ["*.ts"] }),
		).rejects.toThrow();
	});

	test("init retains successful setup when a module factory needs retry", async () => {
		const { root, write } = await fixture();
		await write(
			"retry.mjs",
			'export default client => { if (!client.tried) { client.tried = true; throw new Error("retry"); } };',
		);
		class Bot extends DiscordClient {
			setups = 0;
			protected override async setup() {
				this.setups++;
			}
		}
		const bot = new Bot(options());
		clients.push(bot);
		bot.custom.root = root;
		bot.custom.modules = { patterns: ["*.mjs"] };
		const login = spyOn(Client.prototype, "login").mockResolvedValue("fake");
		await expect(bot.init()).rejects.toThrow("retry.mjs");
		await bot.init();
		expect(bot.setups).toBe(1);
		expect(login).toHaveBeenCalledTimes(1);
	});
	test("loads default exports and factories once; excludes tests and declarations", async () => {
		const { root, write } = await fixture();
		await write(
			"feature/commands/ping.mjs",
			'export default new DiscordCommand({data: new SlashCommandBuilder().setName("ping").setDescription("Pong"), metadata: {}, execute() {}});',
		);
		await write(
			"feature/events/debug.mjs",
			'export default client => new DiscordEvent({type: "client", name: "debug", method(current) { current.factoryClient = client; }});',
		);
		await write(
			"feature/events/bad.test.mjs",
			'throw new Error("test imported");',
		);
		await write(
			"feature/events/bad.spec.ts",
			'throw new Error("spec imported");',
		);
		await write(
			"feature/events/bad.d.ts",
			'throw new Error("declaration imported");',
		);
		await write(
			"feature/events/__tests__/bad.mjs",
			'throw new Error("test directory imported");',
		);
		const bot = client();
		bot.custom.root = root;
		bot.custom.modules = { patterns: ["**/*.{ts,mjs}", "**/*.mjs"] };
		await Promise.all([bot.loadModules(), bot.loadModules()]);
		expect(bot.commands.size).toBe(1);
		expect(bot.listenerCount("debug")).toBe(1);
		bot.emit("debug", "x");
		expect(Reflect.get(bot, "factoryClient")).toBe(bot);
		const second = client();
		second.custom.root = root;
		second.custom.modules = bot.custom.modules;
		await second.loadModules();
		second.emit("debug", "x");
		expect(second.commands.size).toBe(1);
		expect(Reflect.get(second, "factoryClient")).toBe(second);
	});

	test("discovery is explicit and failed factories can retry without reloading successes", async () => {
		const { root, write } = await fixture();
		await write(
			"a.mjs",
			'export default client => { client.loads = (client.loads ?? 0) + 1; return new DiscordEvent({ type: "client", name: "debug", method() {} }); };',
		);
		await write(
			"b.mjs",
			'export default client => { if (!client.tried) { client.tried = true; throw new Error("retry me"); } };',
		);
		const bot = client();
		bot.custom.root = root;
		await bot.loadModules();
		expect(Reflect.get(bot, "loads")).toBeUndefined();
		await expect(bot.loadModules({ patterns: ["*.mjs"] })).rejects.toThrow(
			"b.mjs",
		);
		await bot.loadModules({ patterns: ["*.mjs"] });
		expect(Reflect.get(bot, "loads")).toBe(1);
		expect(bot.listenerCount("debug")).toBe(1);
	});

	test("an invalid default export blocks login with the failing path", async () => {
		const { root, write } = await fixture();
		await write("invalid.mjs", "export default { broken: true };");
		const bot = client();
		bot.custom.root = root;
		bot.custom.modules = { patterns: ["*.mjs"] };
		const login = spyOn(Client.prototype, "login").mockResolvedValue("fake");
		await expect(bot.login()).rejects.toThrow("invalid.mjs");
		expect(login).not.toHaveBeenCalled();
	});
});

describe("command registration", () => {
	test("guild/global scopes, changed bodies, and force are independent", async () => {
		const bot = client();
		bot.registerPiece(command());
		const put = spyOn(bot.rest, "put").mockResolvedValue([]);
		await Promise.all([bot.registerCommands(), bot.registerCommands()]);
		expect(put).toHaveBeenCalledTimes(1);
		expect(put.mock.calls[0]?.[0]).toBe(
			"/applications/app/guilds/guild/commands",
		);
		await bot.registerCommands({ guildId: null });
		expect(put.mock.calls[1]?.[0]).toBe("/applications/app/commands");
		bot.registerPiece(command("other"));
		await bot.registerCommands();
		await bot.registerCommands({ force: true });
		expect(put).toHaveBeenCalledTimes(4);
	});

	test("failed REST writes are retried and cannot poison a scope", async () => {
		const bot = client();
		bot.registerPiece(command());
		const put = spyOn(bot.rest, "put")
			.mockRejectedValueOnce(new Error("Discord unavailable"))
			.mockResolvedValue([]);
		await expect(bot.registerCommands()).rejects.toThrow("Discord unavailable");
		await bot.registerCommands();
		expect(put).toHaveBeenCalledTimes(2);
	});

	test("queued updates preserve invocation order", async () => {
		const bot = client();
		bot.registerPiece(command());
		const first = Promise.withResolvers<unknown>();
		const put = spyOn(bot.rest, "put")
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValue([]);
		const one = bot.registerCommands();
		await tick();
		bot.registerPiece(command("second"));
		const two = bot.registerCommands();
		await tick();
		expect(put).toHaveBeenCalledTimes(1);
		first.resolve([]);
		await Promise.all([one, two]);
		expect(put).toHaveBeenCalledTimes(2);
		expect(put.mock.calls[1]?.[1]?.body).toHaveLength(2);
	});

	test("requires explicit target, application ID, and empty-set authorization", async () => {
		const bot = client();
		const put = spyOn(bot.rest, "put").mockResolvedValue([]);
		await expect(bot.registerCommands()).rejects.toThrow("allowEmpty");
		bot.custom.operatingGuildId = undefined;
		await expect(bot.registerCommands({ allowEmpty: true })).rejects.toThrow(
			"guildId",
		);
		bot.custom.applicationId = undefined;
		await expect(
			bot.registerCommands({ guildId: null, allowEmpty: true }),
		).rejects.toThrow("application ID");
		expect(put).not.toHaveBeenCalled();
		await bot.registerCommands({
			applicationId: "explicit",
			guildId: null,
			allowEmpty: true,
		});
		expect(put.mock.calls[0]).toEqual([
			"/applications/explicit/commands",
			{ body: [] },
		]);
	});
});

describe("guild access and diagnostics", () => {
	test("guild caches belong to the instance and are read fresh", async () => {
		const one = client();
		const two = client();
		const first = { id: "guild" } as Guild;
		const second = { id: "guild" } as Guild;
		one.guilds.cache.set("guild", first);
		two.guilds.cache.set("guild", second);
		expect(one.mainGuild).toBe(first);
		expect(two.mainGuild).toBe(second);
		one.guilds.cache.delete("guild");
		expect(() => one.mainGuild).toThrow("not cached");
		const fetch = spyOn(one.guilds, "fetch").mockResolvedValue(first as never);
		expect(await one.fetchMainGuild()).toBe(first);
		expect(fetch).toHaveBeenCalledWith("guild");
		one.custom.operatingGuildId = undefined;
		expect(() => one.mainGuild).toThrow("operatingGuildId");
	});

	test("stats count caches without forcing GC", () => {
		const bot = client();
		bot.guilds.cache.set("guild", {
			members: {
				cache: new Collection([
					["a", {}],
					["b", {}],
				]),
			},
			presences: { cache: new Collection([["a", {}]]) },
		} as Guild);
		bot.registerPiece(command());
		const stats = bot.getStats();
		expect(stats.cache.members).toBe(2);
		expect(stats.cache.presences).toBe(1);
		expect(stats.commands).toBe(1);
		expect(stats.memory.rss).toBeGreaterThan(0);
		expect(stats.ready).toBe(false);
	});
});

describe("shutdown", () => {
	test("stop, drain, Discord, cleanup order and idempotency", async () => {
		const bot = client();
		const order: string[] = [];
		const event = mock(() => {});
		bot.registerPiece(
			new DiscordEvent({ type: "client", name: "debug", method: event }),
		);
		await bot.loadModules();
		const destroy = spyOn(Client.prototype, "destroy").mockImplementation(
			async () => {
				order.push("Discord");
			},
		);
		bot.addShutdownHook("cleanup", () => {
			order.push("cleanup");
		});
		bot.addShutdownHook(
			"drain",
			() => {
				order.push("drain");
			},
			{ stage: "drain" },
		);
		bot.addShutdownHook(
			"stop",
			() => {
				order.push("stop");
			},
			{ stage: "stop" },
		);
		const remove = bot.addShutdownHook("removed", () => {
			order.push("removed");
		});
		remove();
		remove();
		const first = bot.kill();
		expect(bot.kill()).toBe(first);
		expect(bot.shutdownSignal.aborted).toBe(true);
		bot.emit("debug", "ignored");
		await first;
		await bot.kill();
		expect(order).toEqual(["stop", "drain", "Discord", "cleanup"]);
		expect(event).not.toHaveBeenCalled();
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(() => bot.registerPiece(command())).toThrow("shutting down");
	});

	test("destroy removes owned listeners and only its own container reference", async () => {
		const old = client();
		const current = client();
		const external = mock(() => {});
		old.on("debug", external);
		old.registerPiece(
			new DiscordEvent({ type: "rest", name: "restDebug", method: () => {} }),
		);
		await old.loadModules();
		await old.destroy();
		expect(container.client).toBe(current);
		expect(old.rest.listenerCount("restDebug")).toBe(0);
		external.mockClear();
		old.emit("debug", "external remains");
		expect(external).toHaveBeenCalledTimes(1);
		await current.destroy();
		expect(() => getClient()).toThrow("container is empty");
	});

	test("a hung hook cannot prevent cleanup within its remaining budget", async () => {
		const bot = client();
		const errors = spyOn(bot.log, "error").mockImplementation(() => {});
		let cleaned = false;
		let signal: AbortSignal | undefined;
		bot.addShutdownHook(
			"hung",
			(received) => {
				signal = received;
				return new Promise(() => {});
			},
			{ stage: "drain", timeoutMs: 10 },
		);
		bot.addShutdownHook("cleanup", () => {
			cleaned = true;
		});
		await bot.kill();
		expect(cleaned).toBe(true);
		expect(signal?.aborted).toBe(true);
		expect(errors).toHaveBeenCalled();
	});

	test("exhausting the budget still initiates Discord teardown", async () => {
		const bot = client();
		bot.custom.shutdownTimeoutMs = 10;
		spyOn(bot.log, "error").mockImplementation(() => {});
		const destroy = spyOn(Client.prototype, "destroy").mockResolvedValue();
		bot.addShutdownHook("hung", () => new Promise(() => {}), {
			stage: "stop",
			timeoutMs: 100,
		});
		await bot.kill();
		await tick();
		expect(destroy).toHaveBeenCalledTimes(1);
	});

	test("phase failures and reporter exceptions cannot stop later phases", async () => {
		const done = mock(() => {});
		const failures = await runDiscordShutdown(
			[
				{
					label: "bad",
					tasks: [
						() => {
							throw new Error("task");
						},
						async () => {
							throw new Error("async task");
						},
					],
				},
				{ label: "next", tasks: [done] },
			],
			{
				onError: () => {
					throw new Error("reporter");
				},
			},
		);
		expect(done).toHaveBeenCalledTimes(1);
		expect(failures).toHaveLength(4);
	});

	test("invalid deadlines are rejected before any tasks run", async () => {
		const task = mock(() => {});
		await expect(
			runDiscordShutdown([{ label: "bad", timeoutMs: 0, tasks: [task] }]),
		).rejects.toThrow(RangeError);
		await expect(
			runDiscordShutdown([], { budgetMs: Number.NaN }),
		).rejects.toThrow(RangeError);
		expect(task).not.toHaveBeenCalled();
	});
});
