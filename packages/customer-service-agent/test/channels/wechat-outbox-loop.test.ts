import { describe, expect, it } from "vitest";
import { runWechatOutboxLoop } from "../../src/channels/wechat/outbox-loop.ts";

describe("runWechatOutboxLoop", () => {
	it("checks for new desk replies independently of the WeChat inbound long poll", async () => {
		const abort = new AbortController();
		let replyAvailable = false;
		let drainCount = 0;
		const waits: number[] = [];

		await runWechatOutboxLoop({
			signal: abort.signal,
			idleDelayMs: 250,
			async drain() {
				drainCount += 1;
				if (!replyAvailable) return 0;
				abort.abort();
				return 1;
			},
			async wait(delayMs) {
				waits.push(delayMs);
				replyAvailable = true;
			},
			onError(error) {
				throw error;
			},
		});

		expect(drainCount).toBe(2);
		expect(waits).toEqual([250]);
	});
});
