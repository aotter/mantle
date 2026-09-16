/** Markdown-only insert snippets for the Admin markdown toolbar.
 *  Every value is CommonMark/GFM — never HTML tags. */

export const MARKDOWN_TOOLBAR_INSERTS = {
  h1: { before: "# ", after: "" },
  h2: { before: "## ", after: "" },
  h3: { before: "### ", after: "" },
  h4: { before: "#### ", after: "" },
  h5: { before: "##### ", after: "" },
  h6: { before: "###### ", after: "" },
  quote: { before: "> ", after: "", block: true },
  codeFence: { before: "```\n", after: "\n```", block: true },
  bold: { before: "**", after: "**" },
  italic: { before: "_", after: "_" },
  strike: { before: "~~", after: "~~" },
  inlineCode: { before: "`", after: "`" },
  bulletList: { before: "- ", after: "", block: true },
  numberList: { before: "1. ", after: "", block: true },
  checkList: { before: "- [ ] ", after: "", block: true },
  indent: { before: "  ", after: "" },
  link: { before: "[", after: "](https://)" },
  table: { before: "|  |  |\n| --- | --- |\n|  |  |", after: "", block: true },
} as const;

export type MarkdownToolbarInsert = keyof typeof MARKDOWN_TOOLBAR_INSERTS;

export function markdownImageSnippet(url: string, alt: string): string {
  return `![${alt}](${url})`;
}

export function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after = "",
  placeholder = "",
): { next: string; cursorStart: number; cursorEnd: number } {
  const selected = value.slice(start, end) || placeholder;
  const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
  const cursorStart = start + before.length;
  return { next, cursorStart, cursorEnd: cursorStart + selected.length };
}

export function applyMarkdownInsert(
  value: string,
  start: number,
  end: number,
  key: MarkdownToolbarInsert,
  placeholder = "",
): { next: string; cursorStart: number; cursorEnd: number } {
  const snippet = MARKDOWN_TOOLBAR_INSERTS[key];
  if ("block" in snippet && snippet.block) {
    const prefix = value.slice(0, start).endsWith("\n") || start === 0 ? "" : "\n\n";
    return wrapSelection(value, start, end, `${prefix}${snippet.before}`, snippet.after, placeholder);
  }
  return wrapSelection(value, start, end, snippet.before, snippet.after, placeholder);
}
