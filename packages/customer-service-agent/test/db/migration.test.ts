import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("initial MySQL migration", () => {
	it("does not reset live inventory when the seed is applied again", async () => {
		const path = fileURLToPath(new URL("../../migrations/001_initial.sql", import.meta.url));
		const sql = await readFile(path, "utf8");

		expect(sql).not.toContain("ON DUPLICATE KEY UPDATE available_quantity = VALUES(available_quantity)");
	});
});
