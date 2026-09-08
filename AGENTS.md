# @lilsnibbi/discord-kit

Keep responses minimal: bare essentials, short paragraphs, no padding.
Never commit, push, tag, publish, or run release automation unless explicitly requested.
Preserve existing user changes and public APIs. Prefer focused fixes over broad rewrites.

## Project

Bun-only, strict TypeScript, ESM. Published source is `src/index.ts`; there is no build step.
Use Bun for packages and scripts. `discord.js` is a required peer; `@lilsnibbi/logger` is the runtime dependency.

- `DiscordClient.ts`: client, logger, environment validation, and piece registry.
- `DiscordCommand.ts` / `DiscordEvent.ts`: class-based command and event definitions.
- `DiscordPagination.ts`: embed and Components V2 pagination.
- `container.ts`: shared client reference and guarded `getClient()`.
- `tests/`: Bun tests; simulate interactions without contacting Discord.

## Conventions

- Use tabs, double quotes, and LF; follow Biome configuration.
- Keep types alongside their implementation, with JSDoc for public symbols.
- Preserve root exports, module augmentation points, and event-source overload inference.
- Load self-registering pieces with dynamic imports after constructing the client.
- Scope pagination actions to the message and initiating user; handle deferred replies and collector expiry.
- Test behavioural fixes without real bot tokens or gateway connections.

## Verification

Run `bun run check` (typecheck, tests, release metadata, lint).
Use `bun run audit` and `bun pm pack --dry-run` for dependency and package checks.
CI installs with `bun install --frozen-lockfile`; keep a reproducible `bun.lock`.
For sibling logger development, use a local Bun link without changing published dependency ranges.
The declared logger version must exist on npm before generating the registry lockfile; publish the logger first when preparing releases.

## Releases

The single `release.yml` workflow matches an entire `vX.Y.Z` tip commit message on the default branch. It verifies, updates metadata, atomically pushes the version commit and tag, publishes to npm, and generates GitHub release notes. Ordinary commits do not release. See `.github/RELEASE_POLICY.md` for setup and retries.
Release scripts can commit and push. Do not run them during ordinary verification.
Keep duplicated release helpers aligned with sibling `logger` and `toolkit` repositories.
