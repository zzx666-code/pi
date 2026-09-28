export interface WechatOutboxLoopOptions {
	signal: AbortSignal;
	drain(): Promise<number>;
	idleDelayMs?: number;
	errorDelayMs?: number;
	wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	onError(error: unknown): void;
}

function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timeout = setTimeout(done, delayMs);
		function done(): void {
			clearTimeout(timeout);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Sends channel outbox messages without waiting for the independent WeChat inbound long poll. */
export async function runWechatOutboxLoop(options: WechatOutboxLoopOptions): Promise<void> {
	const wait = options.wait ?? waitFor;
	while (!options.signal.aborted) {
		try {
			const claimed = await options.drain();
			if (claimed === 0) await wait(options.idleDelayMs ?? 250, options.signal);
		} catch (error) {
			options.onError(error);
			if (!options.signal.aborted) await wait(options.errorDelayMs ?? 3_000, options.signal);
		}
	}
}
