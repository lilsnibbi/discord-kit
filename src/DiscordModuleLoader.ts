import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Discovery options, resolved relative to `custom.root`. */
export interface DiscordModuleOptions {
	/** Directory containing feature folders. Defaults to `custom.root`. */
	directory?: string;
	/** Explicit entrypoints only; no discovery happens when patterns are omitted. */
	patterns?: readonly string[];
}

/**
 * Discovers sorted, unique module entrypoints. Tests, declarations and
 * node_modules are excluded even when a broad pattern is supplied.
 */
export async function discoverDiscordModules(
	root: string,
	options: DiscordModuleOptions,
): Promise<string[]> {
	const paths = new Set<string>();
	const directory = resolve(root, options.directory ?? ".");
	if (options.patterns?.length && !(await stat(directory)).isDirectory()) {
		throw new Error(
			`Discord module directory is not a directory: ${directory}`,
		);
	}
	for (const pattern of options.patterns ?? []) {
		for await (const path of new Bun.Glob(pattern).scan({
			cwd: directory,
			absolute: true,
			onlyFiles: true,
		})) {
			const normalized = path.replaceAll("\\", "/");
			if (
				/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(normalized) ||
				/(?:^|\/)(?:node_modules|__tests__|__mocks__)(?:\/|$)/.test(normalized)
			)
				continue;
			paths.add(resolve(path));
		}
	}
	return [...paths].sort();
}

/** Imports via file URLs so Windows paths and reserved URL characters work. */
export async function importDiscordModule(path: string): Promise<unknown> {
	return (await import(pathToFileURL(path).href)).default;
}
