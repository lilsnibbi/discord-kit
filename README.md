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

`registerPiece` takes a `DiscordEvent` or a `DiscordCommand`; commands are
keyed by `data.name`, so registering the same name twice keeps the last one.

### `container`

The process-wide dependency bag, populated by the `DiscordClient` constructor.
It is a mutable object rather than a re-exported binding, so importers always
read the current value.

```ts
import { container, getClient } from "@lilsnibbi/discord-kit";

container.client.log.notif("ready");
getClient().log.notif("same client, but throws if none exists yet");
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
