import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface KnowledgeChunk {
	source: string;
	content: string;
}

export interface KnowledgeDocument extends KnowledgeChunk {
	id: string;
}

export function chunkMarkdown(source: string, markdown: string, maxCharacters = 800): KnowledgeChunk[] {
	const sections = markdown
		.split(/\r?\n(?=#{1,6}\s)/)
		.map((section) => section.trim())
		.filter(Boolean);
	const chunks: KnowledgeChunk[] = [];
	for (const section of sections) {
		if (section.length <= maxCharacters) {
			chunks.push({ source, content: section });
			continue;
		}
		const paragraphs = section.split(/\r?\n\s*\r?\n/);
		let current = "";
		for (const paragraph of paragraphs) {
			const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
			if (candidate.length > maxCharacters && current) {
				chunks.push({ source, content: current });
				current = paragraph;
			} else {
				current = candidate;
			}
		}
		if (current) chunks.push({ source, content: current });
	}
	return chunks;
}

export async function loadKnowledgeDocuments(directory: string): Promise<KnowledgeDocument[]> {
	const entries = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.sort((left, right) => left.name.localeCompare(right.name));
	const documents: KnowledgeDocument[] = [];
	for (const entry of entries) {
		const source = basename(entry.name);
		const markdown = await readFile(join(directory, entry.name), "utf8");
		for (const chunk of chunkMarkdown(source, markdown)) {
			documents.push({
				...chunk,
				id: createHash("sha256").update(`${source}\0${chunk.content}`).digest("hex"),
			});
		}
	}
	return documents;
}
