import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../../src/knowledge/ingestion.ts";

describe("chunkMarkdown", () => {
	it("keeps a markdown heading with the policy paragraphs below it", () => {
		const chunks = chunkMarkdown("refund.md", "# 退款政策\n\n七天内可以申请。\n\n商品必须保持完好。", 40);

		expect(chunks).toEqual([
			{ source: "refund.md", content: "# 退款政策\n\n七天内可以申请。\n\n商品必须保持完好。" },
		]);
	});
});
