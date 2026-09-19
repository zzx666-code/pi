import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Splits a migration script into the individual statements a driver can execute. */
export function splitStatements(sql: string): string[] {
	return sql
		.split(/;\s*(?:\r?\n|$)/)
		.map((statement) => statement.trim())
		.filter(Boolean);
}

/**
 * Everything the migration loop needs from a database.
 *
 * Behind an interface so the skip logic can be tested without MySQL: the rule that matters
 * is "a migration is applied at most once", not how the recording is stored.
 */
export interface MigrationRunner {
	ensureVersionTable(): Promise<void>;
	/** Names of the migrations that already ran, in any order. */
	appliedMigrations(): Promise<readonly string[]>;
	/** Runs one migration and records it, so the next run skips it. */
	runMigration(name: string, statements: readonly string[]): Promise<void>;
}

/**
 * Applies every `*.sql` file in `directory` at most once, in filename order.
 *
 * The version table — not the SQL itself — is what makes re-running safe: MySQL 8 has no
 * `ADD COLUMN IF NOT EXISTS`, so an `ALTER TABLE` migration would fail on the second run.
 * Returns the names applied by this call, so callers can report what changed.
 */
export async function applyMigrations(runner: MigrationRunner, directory: string): Promise<string[]> {
	await runner.ensureVersionTable();
	const alreadyApplied = new Set(await runner.appliedMigrations());
	const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

	const applied: string[] = [];
	for (const name of files) {
		if (alreadyApplied.has(name)) continue;
		const sql = await readFile(join(directory, name), "utf8");
		await runner.runMigration(name, splitStatements(sql));
		applied.push(name);
	}
	return applied;
}
