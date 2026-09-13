# @lilsnibbi/discord-kit

Client, command, event and pagination structures for [discord.js](https://discord.js.org/)
bots on the [Bun](https://bun.sh/) runtime. The client carries a
[`@lilsnibbi/logger`](https://www.npmjs.com/package/@lilsnibbi/logger)
instance and publishes itself to a Sapphire-style `container`.

The package ships raw TypeScript — there is no build step and no compiled
output. Consumers need Bun, or a bundler that resolves `.ts` imports.

```bash
bun add @lilsnibbi/discord-kit discord.js
```

`discord.js` is a peer dependency and must be installed alongside.

## Usage

### `DiscordClient`

A `Client` that carries its own `Logger`, a piece registry, and publishes
itself to the `container`. Pass discord.js' own options alongside a `custom`
bag; `login` checks `requiredEnvs`, attaches every registered event, then
connects.

```ts
import { DiscordClient } from "@lilsnibbi/discord-kit";

const client = new DiscordClient({
  intents: [GatewayIntentBits.Guilds],
  custom: {
    logger: { name: "bot" },
    requiredEnvs: ["BOT_TOKEN"],
    root: import.meta.dir,
    botToken: Bun.env.BOT_TOKEN as string,
  },
});

await import("./events/ready"); // dynamic — see below
await client.login();
```

`registerPiece` takes a `DiscordEvent` or a `DiscordCommand`. Commands are
keyed by `data.name`, so registering the same name twice keeps the last one
unless `custom.duplicateCommands` is `"skip"` or `"error"`. Names must be unique
across slash and context-menu commands. `client.commands` is the same map as
`client.components.commands`.

Events are bound once per piece instance. Events added after `loadModules`
bind immediately; `unregisterPiece(piece)` removes just that piece's listener.
Consumed `once` events stay consumed until explicitly unregistered and
registered again. Both synchronous exceptions and rejected event promises go
through the overridable `onError(error, context)` method.

#### Module discovery

```ts
const client = new DiscordClient({
  intents: [GatewayIntentBits.Guilds],
  custom: {
    logger: { name: "bot" },
    requiredEnvs: ["BOT_TOKEN"],
    root: import.meta.dir,
    botToken: Bun.env.BOT_TOKEN as string,
    operatingGuildId: Bun.env.DISCORD_GUILD_ID,
    duplicateCommands: "error",
    modules: {
      directory: "core/modules",
      patterns: ["*/{commands,events}/*.ts"],
    },
  },
});

await client.init();
```

Patterns use [Bun Glob syntax](https://bun.com/docs/runtime/glob). Discovery is
opt-in: no patterns means no filesystem imports. Paths resolve from
`custom.root`, are sorted and deduplicated, and exclude `.test`, `.spec`,
declaration files, `__tests__`, `__mocks__`, and `node_modules`. Keep patterns
narrow so helper files are not treated as entrypoints.

Files can default-export a piece, an array of pieces, or an async factory that
receives the client and returns either. Factories also work when Bun has already
cached the module and another client loads it:

```ts
import { DiscordEvent } from "@lilsnibbi/discord-kit";
import type { BotClient } from "../../structures/BotClient";

export default (client: BotClient) => new DiscordEvent({
  type: "client",
  name: "clientReady",
  once: true,
  async method() {
    await client.registerCommands();
  },
});
```

`loadModules()` can also be awaited directly without connecting. Import or
factory failures reject with the file path and original `cause`; successful
files remain loaded on retry. A factory failure is retryable, but Bun may cache
a module evaluation failure: fix the file and restart in that case. Imports and
factories should avoid unrelated side effects; their service changes cannot be
rolled back by the loader. Default exports/factories are preferred to container
self-registration when using multiple clients.

#### Startup and command registration

Subclass `DiscordClient` and override `protected async setup()` to initialize
application services. `init()` validates the environment, awaits setup, loads
modules, and logs in. Concurrent calls share the same promise. Successful setup
is retained if a later import fails; a rejected setup can be retried and must
clean up its own partial work. `login()` skips setup. Choose one startup path.
Neither method waits for async `clientReady` handlers to finish. Actual gateway
login failures can destroy the discord.js client; use a new instance then.

Command registration is an explicit REST operation, usually called from a
`clientReady` event:

```ts
await client.registerCommands(); // custom.operatingGuildId
await client.registerCommands({ guildId: "another-guild" });
await client.registerCommands({ guildId: null }); // explicitly global
await client.registerCommands({ force: true }); // resend an unchanged set
```

This **replaces the entire command set in the selected scope**. Empty registries
are rejected unless `allowEmpty: true` is supplied. There is no implicit global
fallback and no automatic registration on login. Repeated successful bodies
are skipped locally; failed requests can be retried. Writes to the same scope
are serialized. Use `force` if another process changed the remote commands.
Before gateway login, supply `custom.applicationId` (or `applicationId` per
call) and authenticate the REST manager explicitly with
`client.rest.setToken(token)`.

Command execution, autocomplete routing, component events, permission checks,
and interaction replies remain owned by your dispatcher. Registering a command
does not execute it or enforce custom metadata.

#### Guild access, diagnostics, and shutdown

`mainGuild` reads the configured guild from this client's cache and throws if
unavailable. `fetchMainGuild()` provides an asynchronous fetch. `getStats()`
returns readiness, uptime, gateway ping, process memory in bytes, and counts of
guilds, users, channels, members, presences, cached messages, commands, and active
piece listeners. It does not start timers or force garbage collection.

Register application cleanup hooks as services are initialized:

```ts
client.addShutdownHook("stop jobs", () => scheduler.stop(), { stage: "stop" });
client.addShutdownHook("drain AI", signal => ai.close(signal), {
  stage: "drain",
  timeoutMs: 4_000,
});
client.addShutdownHook("RPC", () => rpc.stop());
client.addShutdownHook("database", () => database.close());

await client.kill();
```

The services above are application-owned. Hooks run in insertion order within
`stop`, then `drain`, then Discord disconnects, then `cleanup` runs. The default
hook deadline is 1,500ms and the shared `custom.shutdownTimeoutMs` budget is
7,000ms. A timed-out hook receives an aborted signal; cancellation is cooperative
and the underlying work may continue. Later hooks can be skipped when the total
budget expires, but Discord teardown is always initiated. A resolved `kill()`
means the bounded shutdown attempt finished, not that every resource closed.

`shutdownSignal` aborts immediately and owned event listeners detach when
shutdown starts. In-flight handlers and listeners attached with plain `.on()`
remain the application's responsibility; use drain hooks and the signal.
Repeated `kill()` calls share one promise. `destroy()` disconnects immediately
without invoking application hooks. No process signal handlers, forced exits,
database connections, or deployment leases are installed by the package.

For custom phase ordering or parallel tasks within phases, use the exported
`runDiscordShutdown(phases, options)` helper. It returns failures and timeouts
and continues within a shared deadline.

#### Moving Lumi to this client

Keep Lumi's `BotClient` as a thin subclass with its existing AI, database, cache,
RPC, Stripe, reporters, and subscription fields. Change its base to
`DiscordClient`, and supply the `custom` options alongside Lumi's current
intents, cache limits, sweepers, presence, and other discord.js settings.

| Current Lumi responsibility | Migration |
| --- | --- |
| Logger and command map | Inherit `log` and `commands`; remove the duplicate fields. |
| `ModuleLoader` and loaded flag | Configure `modules.directory` and `patterns`; remove the old loader. |
| Service initialization inside `init` | Move to `setup`; retain lease acquisition before constructing the bot. |
| `registerCommands` and registered flag | Inherit it; keep the existing ready event's explicit call. |
| Module-level cached guild | Inherit `mainGuild` with `operatingGuildId`. |
| Shutdown state and phases | Register stop/drain/cleanup hooks, or retain custom orchestration using `runDiscordShutdown`. |
| Event error reporting | Override `onError` and call Lumi's reporter. |
| Periodic memory logging | Read `getStats()` alongside Lumi-specific database/cache metrics. |

Keep Lumi's interaction dispatcher and all role checks, custom interaction
events, RPC startup, subscription reconciliation, resource cleanup, process
signals, and lease ownership. Remove duplicate lifecycle implementations as
each responsibility moves across. No Lumi source files are changed by this
package update.

### `container`

The process-wide dependency bag, populated by the `DiscordClient` constructor.
It is a mutable object rather than a re-exported binding, so importers always
read the current value.

```ts
import { container, getClient } from "@lilsnibbi/discord-kit";

container.client.log.notif("ready");
getClient().log.notif("same client, but throws if none exists yet");
getClient(BotClient).subscriptions; // typed subclass lookup, checked with instanceof
```

Register your own singletons by augmenting `Container`:

```ts
declare module "@lilsnibbi/discord-kit" {
  interface Container {
    db: Database;
  }
}
```

A piece file that calls `container.client.registerPiece(...)` at import time
must be loaded with `await import("./file")` **after** the client is
constructed. A static `import "./file"` is hoisted above the constructor call,
so the container would still be empty — and a module already imported
statically is cached, so a later dynamic import will not re-run it.

Destroying the active client clears its shared reference. Destroying an older
client leaves a newer client's reference intact. `getClient(ClientClass)` throws
if the active client is not an instance of that class.

### `DiscordCommand`

Bundles a command definition with its handlers so a loader can register `data`
and dispatch `execute` without a second lookup table.

```ts
import { DiscordCommand } from "@lilsnibbi/discord-kit";

export default new DiscordCommand({
  data: new SlashCommandBuilder().setName("ping").setDescription("Pong."),
  metadata: {},
  execute: async (_client, interaction) => {
    await interaction.reply("Pong!");
  },
});
```

Give `metadata` a type across the whole project by augmenting
`DiscordCommandMetadata`:

```ts
declare module "@lilsnibbi/discord-kit" {
  interface DiscordCommandMetadata {
    cooldown?: number;
    category?: string;
  }
}
```

### `DiscordEvent`

The `type` discriminant selects which event map `name` and the handler
arguments are checked against — `"client"`, `"rest"`, or `"custom"`.

```ts
import { DiscordEvent } from "@lilsnibbi/discord-kit";

export default new DiscordEvent({
  type: "client",
  name: "messageCreate",
  method: async (_client, message) => {
    if (!message.author.bot) await message.react("👋");
  },
});
```

Custom events come from augmenting `DiscordEventCustomType`:

```ts
declare module "@lilsnibbi/discord-kit" {
  interface DiscordEventCustomType {
    myEvent: [data: string];
  }
}
```

### `DiscordPagination`

A button-driven paginator in either Components V2 container mode or classic
embed mode. The collector is scoped to the sent message and to the user who
triggered it, and each instance prefixes its button ids, so several paginators
can run in one channel without colliding.

```ts
import { DiscordPagination } from "@lilsnibbi/discord-kit";

await new DiscordPagination(entries, {
  type: "container",
  layout: [
    "# Leaderboard",
    new SeparatorBuilder(),
    DiscordPagination.DATA,
    new SeparatorBuilder(),
    DiscordPagination.BUTTONS,
  ],
  accentColor: 0x5865f2,
}).send(interaction);
```

In container mode, `layout` is a flat template rendered on every page;
`DiscordPagination.DATA` and `DiscordPagination.BUTTONS` mark where the entries
and the navigation buttons go. Bare strings become text displays.

```ts
await new DiscordPagination(entries, {
  type: "embed",
  embed: new EmbedBuilder().setTitle("Leaderboard").setColor(0x5865f2),
  showSkipButtons: true,
}).send(interaction);
```

In embed mode the embed's `description` and `footer` are overwritten each page
with the entries and the page counter.

`send` accepts a `ChatInputCommandInteraction`, a `ButtonInteraction` or a
`Message`. Shared options: `entriesPerPage` (default 5), `replacements`,
`ephemeral`, `idleTimeout` (default 60s), `buttons`, `showSkipButtons` and
`onEnd`. When the timeout elapses the buttons are disabled rather than removed.

## Development

```bash
bun test                          # run the suite
bun run check                     # typecheck, tests, release metadata, biome
bun run pretty                    # format
```

Releases use Conventional Commits and Release Please. Merge the generated release PR
after CI passes to create the version, changelog, GitHub release, and npm package.
Configure `RELEASE_TOKEN` and `NPM_TOKEN`; see
[.github/RELEASE_POLICY.md](.github/RELEASE_POLICY.md).

## License

MIT
