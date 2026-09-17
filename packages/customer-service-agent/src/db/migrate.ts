import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { createMysqlPool } from "./mysql.ts";

const migrationPath = fileURLToPath(new URL("../../migrations/001_initial.sql", import.meta.url));
const pool = createMysqlPool(loadConfig().mysqlUrl);

try {
	const sql = await readFile(migrationPath, "utf8");
	const connection = await pool.getConnection();
	try {
		for (const statement of sql
			.split(/;\s*(?:\r?\n|$)/)
			.map((part) => part.trim())
			.filter(Boolean)) {
			await connection.query(statement);
		}
	} finally {
		connection.release();
	}
	console.log("MySQL migration completed");
} finally {
	await pool.end();
}
