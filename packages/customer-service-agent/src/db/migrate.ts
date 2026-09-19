import { fileURLToPath } from "node:url";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { loadConfig } from "../config.ts";
import { applyMigrations, type MigrationRunner } from "./migrator.ts";
import { createMysqlPool } from "./mysql.ts";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

/**
 * MySQL commits DDL implicitly, so a half-applied migration cannot be rolled back. The version
 * row is therefore written last: when a statement fails, the migration stays unrecorded and the
 * next run reports the same error instead of silently skipping past it.
 */
class MySqlMigrationRunner implements MigrationRunner {
	private readonly connection: Connection;

	constructor(connection: Connection) {
		this.connection = connection;
	}

	async ensureVersionTable(): Promise<void> {
		await this.connection.query(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				name VARCHAR(255) NOT NULL PRIMARY KEY,
				applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
			)
		`);
	}

	async appliedMigrations(): Promise<readonly string[]> {
		const [rows] = await this.connection.query<RowDataPacket[]>("SELECT name FROM schema_migrations");
		return rows.map((row) => String(row.name));
	}

	async runMigration(name: string, statements: readonly string[]): Promise<void> {
		for (const statement of statements) {
			await this.connection.query(statement);
		}
		await this.connection.execute("INSERT INTO schema_migrations (name) VALUES (?)", [name]);
	}
}

const pool = createMysqlPool(loadConfig().mysqlUrl);

try {
	const connection = await pool.getConnection();
	try {
		const applied = await applyMigrations(new MySqlMigrationRunner(connection), migrationsDirectory);
		for (const name of applied) console.log(`applied ${name}`);
		console.log(
			applied.length === 0
				? "MySQL schema is already up to date"
				: `MySQL migration completed (${applied.length} applied)`,
		);
	} finally {
		connection.release();
	}
} finally {
	await pool.end();
}
