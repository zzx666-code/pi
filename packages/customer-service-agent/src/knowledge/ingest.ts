import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { createMysqlPool } from "../db/mysql.ts";
import { loadKnowledgeDocuments } from "./ingestion.ts";
import { MySqlKnowledgeGateway } from "./mysql-knowledge.ts";

const directory = fileURLToPath(new URL("../../knowledge", import.meta.url));
const config = loadConfig();
const pool = createMysqlPool(config.mysqlUrl);
const gateway = new MySqlKnowledgeGateway(pool);
const documents = await loadKnowledgeDocuments(directory);
try {
	await gateway.replaceDocuments(documents);
	console.log(`Indexed ${documents.length} knowledge chunks into MySQL`);
} finally {
	await pool.end();
}
