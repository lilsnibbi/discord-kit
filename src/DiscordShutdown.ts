/** A named shutdown phase. Tasks within a phase run concurrently. */
export interface DiscordShutdownPhase {
	label: string;
	tasks: readonly ((signal: AbortSignal) => unknown | Promise<unknown>)[];
	/** Per-phase deadline; defaults to 1,500ms. */
	timeoutMs?: number;
}

/** Options for bounded, best-effort shutdown. */
export interface DiscordShutdownOptions {
	/** Total deadline shared by all phases; defaults to 7,000ms. */
	budgetMs?: number;
	/** Receives task failures, phase timeouts, and skipped phases. */
	onError?: (label: string, error: unknown) => void;
}

/** Reject invalid timer values rather than allowing immediate/overflow timers. */
export function validateShutdownTimeout(value: number): void {
	if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
		throw new RangeError(
			"Shutdown timeouts must be between 0 and 2147483647ms",
		);
	}
}

/**
 * Runs phases in order, continuing after failures. A timed-out phase receives
 * an aborted signal; tasks must cooperate with cancellation. No process exit
 * or signal handlers are installed. Returns every failure, including timeouts.
 */
export async function runDiscordShutdown(
	phases: readonly DiscordShutdownPhase[],
	options: DiscordShutdownOptions = {},
): Promise<{ label: string; error: unknown }[]> {
	const budget = options.budgetMs ?? 7_000;
	validateShutdownTimeout(budget);
	for (const phase of phases) validateShutdownTimeout(phase.timeoutMs ?? 1_500);
	const deadline = performance.now() + budget;
	const failures: { label: string; error: unknown }[] = [];
	const report = (label: string, error: unknown) => {
		failures.push({ label, error });
		try {
			options.onError?.(label, error);
		} catch (reportError) {
			failures.push({ label: `${label}:reporter`, error: reportError });
		}
	};
	for (const phase of phases) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) {
			report(
				phase.label,
				new Error("Shutdown budget exhausted; phase skipped"),
			);
			continue;
		}
		const controller = new AbortController();
		const timeoutMs = Math.min(phase.timeoutMs ?? 1_500, remaining);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const results = await Promise.race([
			Promise.allSettled(
				phase.tasks.map((task) =>
					Promise.resolve().then(() => task(controller.signal)),
				),
			),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), timeoutMs);
			}),
		]);
		clearTimeout(timer);
		if (results === null) {
			const error = new Error(`Shutdown phase timed out after ${timeoutMs}ms`);
			controller.abort(error);
			report(phase.label, error);
		} else {
			for (const result of results) {
				if (result.status === "rejected") report(phase.label, result.reason);
			}
		}
	}
	return failures;
}
