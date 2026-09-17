import type { Pool, RowDataPacket } from "mysql2/promise";
import type { KnowledgeGateway, KnowledgeSearchResult } from "../agent/gateways.ts";
import type { KnowledgeDocument } from "./ingestion.ts";

interface KnowledgeRow extends RowDataPacket {
	source: string;
	content: string;
	score: number;
}

function asLikePattern(query: string): string {
	return `%${query.replace(/[!%_]/g, "!$&")}%`;
}

export class MySqlKnowledgeGateway implements KnowledgeGateway {
	private readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async replaceDocuments(documents: KnowledgeDocument[]): Promise<void> {
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			await connection.execute("DELETE FROM knowledge_documents");
			for (const document of documents) {
				await connection.execute("INSERT INTO knowledge_documents (id, source, content) VALUES (?, ?, ?)", [
					document.id,
					document.source,
					document.content,
				]);
			}
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	async search(query: string): Promise<KnowledgeSearchResult[]> {
		const normalized = query.trim();
		if (!normalized) return [];
		const pattern = asLikePattern(normalized);
		const [rows] = await this.pool.execute<KnowledgeRow[]>(
			"SELECT source, content, (CASE WHEN source LIKE ? ESCAPE '!' THEN 4 ELSE 0 END + CASE WHEN content LIKE ? ESCAPE '!' THEN 1 ELSE 0 END) AS score FROM knowledge_documents WHERE source LIKE ? ESCAPE '!' OR content LIKE ? ESCAPE '!' ORDER BY score DESC, source LIMIT 5",
			[pattern, pattern, pattern, pattern],
		);
		return rows.map((row) => ({ source: row.source, content: row.content, score: Number(row.score) }));
	}
}
