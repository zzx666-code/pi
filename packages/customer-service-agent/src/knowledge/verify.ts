import { loadConfig } from "../config.ts";
import { createMysqlPool } from "../db/mysql.ts";
import { MySqlKnowledgeGateway } from "./mysql-knowledge.ts";

const query = process.argv.slice(2).join(" ").trim() || "配送";
const pool = createMysqlPool(loadConfig().mysqlUrl);
try {
	const results = await new MySqlKnowledgeGateway(pool).search(query);
	console.log(JSON.stringify({ query, results }, null, 2));
} finally {
	await pool.end();
}
