/**
 * The transcript renders plain text, so any Markdown the model emits shows up literally.
 *
 * The system prompt asks for plain text, but models drift; this strips the markers that carry
 * no meaning without a renderer while keeping the line structure the model intended. It only
 * removes markup — it never interprets or executes anything from the model.
 */
export function toPlainText(content: string): string {
	return content
		.replace(/```[^\n]*\n?/g, "")
		.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
		.replace(/^[ \t]{0,3}>[ \t]?/gm, "")
		.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, "· ")
		.replace(/\*\*([^*\n]+)\*\*/g, "$1")
		.replace(/__([^_\n]+)__/g, "$1")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/^[ \t]{0,3}([-*_])[ \t]*\1[ \t]*\1[\s\-*_]*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
