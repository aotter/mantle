import { describe, expect, it } from "vitest";
import {
  insertMarkdownBlock,
  markdownHeadingPrefix,
  markdownImage,
  MARKDOWN_TOOLBAR_BLOCKS,
  MARKDOWN_TOOLBAR_WRAPS,
  wrapMarkdownSelection,
} from "../src/features/editor/markdown-insert";

describe("markdown toolbar inserts", () => {
  it("wraps emphasis, code, and links with Markdown only", () => {
    const wraps = Object.values(MARKDOWN_TOOLBAR_WRAPS);
    for (const wrap of wraps) {
      expect(`${wrap.before}${wrap.after}`).not.toMatch(/<[^>]+>/);
      const edit = wrapMarkdownSelection("body", 0, 4, wrap.before, wrap.after);
      expect(edit.next).toBe(`${wrap.before}body${wrap.after}`);
      expect(edit.next).not.toMatch(/<[^>]+>/);
    }
  });

  it("inserts block constructs as Markdown, not HTML", () => {
    const blocks = [
      MARKDOWN_TOOLBAR_BLOCKS.quote,
      MARKDOWN_TOOLBAR_BLOCKS.bulletList,
      MARKDOWN_TOOLBAR_BLOCKS.numberList,
      MARKDOWN_TOOLBAR_BLOCKS.checkList,
      MARKDOWN_TOOLBAR_BLOCKS.table,
    ];
    for (const block of blocks) {
      expect(block).not.toMatch(/<[^>]+>/);
      const edit = insertMarkdownBlock("intro", 5, 5, block);
      expect(edit.next.startsWith("intro\n\n")).toBe(true);
      expect(edit.next).toContain(block);
    }
  });

  it("builds ATX headings and Markdown images", () => {
    expect(markdownHeadingPrefix(2)).toBe("## ");
    expect(markdownImage("https://cdn.example/a.png", "Alt")).toBe("![Alt](https://cdn.example/a.png)");
  });
});
