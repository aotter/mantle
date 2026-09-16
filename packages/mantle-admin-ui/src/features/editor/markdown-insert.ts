/** Pure Markdown wrap/insert helpers. Toolbar actions must stay MD-only. */

export interface MarkdownEdit {
  next: string;
  cursorStart: number;
  cursorEnd: number;
}

export function wrapMarkdownSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after = "",
  placeholder = "",
): MarkdownEdit {
  const selected = value.slice(start, end) || placeholder;
  const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
  const cursorStart = start + before.length;
  return { next, cursorStart, cursorEnd: cursorStart + selected.length };
}

export function insertMarkdownBlock(
  value: string,
  start: number,
  end: number,
  block: string,
): MarkdownEdit {
  const beforeCursor = value.slice(0, start);
  const prefix = beforeCursor.length === 0 || beforeCursor.endsWith("\n") ? "" : "\n\n";
  return wrapMarkdownSelection(value, start, end, `${prefix}${block}`, "", "");
}

export function markdownHeadingPrefix(level: number): string {
  const clamped = Math.min(6, Math.max(1, level));
  return `${"#".repeat(clamped)} `;
}

export function markdownImage(url: string, alt: string): string {
  return `![${alt}](${url})`;
}

/** Document the MD-only wraps so tests can reject HTML chrome. */
export const MARKDOWN_TOOLBAR_WRAPS = {
  bold: { before: "**", after: "**" },
  italic: { before: "_", after: "_" },
  strike: { before: "~~", after: "~~" },
  inlineCode: { before: "`", after: "`" },
  link: { before: "[", after: "](https://)" },
} as const;

export const MARKDOWN_TOOLBAR_BLOCKS = {
  quote: "> ",
  bulletList: "- ",
  numberList: "1. ",
  checkList: "- [ ] ",
  table: "|  |  |\n| --- | --- |\n|  |  |",
  codeFence: { before: "```\n", after: "\n```" },
} as const;
