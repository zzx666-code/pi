import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, type MigrationRunner, splitStatements } from "../../src/db/migrator.ts";

/** In-memory stand-in for the database, so the skip logic is testable without MySQL. */
class FakeMigrationRunner implements MigrationRunner {
	readonly applied = new Set<string>();
	readonly runs: { name: string; statements: readonly string[] }[] = [];

	async ensureVersionTable(): Promise<void> {
		// The real runner creates the version table; the fake keeps the same contract in memory.
	}

	async appliedMigrations(): Promise<readonly string[]> {
		return [...this.applied];
	}

	async runMigration(name: string, statements: readonly string[]): Promise<void> {
		this.runs.push({ name, statements });
		this.applied.add(name);
	}
}

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-customer-service-migrations-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function writeMigration(name: string, sql: string): Promise<void> {
	await writeFile(join(directory, name), sql, "utf8");
}

describe("applyMigrations", () => {
	it("applies every migration in filename order", async () => {
		await writeMigration("002_second.sql", "ALTER TABLE orders ADD COLUMN note VARCHAR(10);");
		await writeMigration("001_first.sql", "CREATE TABLE orders (id CHAR(36));");

		const applied = await applyMigrations(new FakeMigrationRunner(), directory);

		expect(applied).toEqual(["001_first.sql", "002_second.sql"]);
	});

	// The whole point of the version table: MySQL 8 has no ADD COLUMN IF NOT EXISTS, so a
	// second run must not re-execute a migration that already succeeded.
	it("skips migrations that already ran", async () => {
		await writeMigration("001_first.sql", "CREATE TABLE orders (id CHAR(36));");
		const runner = new FakeMigrationRunner();
		await applyMigrations(runner, directory);

		const applied = await applyMigrations(runner, directory);

		expect(applied).toEqual([]);
		expect(runner.runs).toHaveLength(1);
	});

	it("applies only the migrations added since the previous run", async () => {
		await writeMigration("001_first.sql", "CREATE TABLE orders (id CHAR(36));");
		const runner = new FakeMigrationRunner();
		await applyMigrations(runner, directory);
		await writeMigration("002_second.sql", "ALTER TABLE orders ADD COLUMN note VARCHAR(10);");

		const applied = await applyMigrations(runner, directory);

		expect(applied).toEqual(["002_second.sql"]);
		expect(runner.runs.map((run) => run.name)).toEqual(["001_first.sql", "002_second.sql"]);
	});

	it("ignores files that are not SQL", async () => {
		await writeMigration("001_first.sql", "CREATE TABLE orders (id CHAR(36));");
		await writeFile(join(directory, "notes.md"), "not a migration", "utf8");

		const applied = await applyMigrations(new FakeMigrationRunner(), directory);

		expect(applied).toEqual(["001_first.sql"]);
	});

	it("hands each migration its own statements", async () => {
		await writeMigration(
			"001_first.sql",
			"CREATE TABLE orders (id CHAR(36));\nALTER TABLE orders ADD COLUMN note VARCHAR(10);\n",
		);
		const runner = new FakeMigrationRunner();

		await applyMigrations(runner, directory);

		expect(runner.runs[0]?.statements).toEqual([
			"CREATE TABLE orders (id CHAR(36))",
			"ALTER TABLE orders ADD COLUMN note VARCHAR(10)",
		]);
	});
});

describe("splitStatements", () => {
	it("splits a script on semicolons and drops blank entries", () => {
		expect(splitStatements("CREATE TABLE a (id INT);\n\nALTER TABLE a ADD COLUMN b INT;\n")).toEqual([
			"CREATE TABLE a (id INT)",
			"ALTER TABLE a ADD COLUMN b INT",
		]);
	});

	it("tolerates a missing trailing semicolon", () => {
		expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"]);
	});
});
