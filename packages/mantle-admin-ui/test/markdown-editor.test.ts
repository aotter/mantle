import { describe, expect, it } from "vitest";
import { MARKDOWN_TOOLBAR_INSERTS, applyMarkdownInsert, markdownImageSnippet } from "../src/features/editor/markdown-snippets";
import { renderMarkdownPreview } from "../src/features/editor/markdown-preview";

describe("markdown toolbar inserts", () => {
  it("never inserts HTML tags", () => {
    for (const [key, snippet] of Object.entries(MARKDOWN_TOOLBAR_INSERTS)) {
      expect(`${snippet.before}${snippet.after}`, key).not.toMatch(/<[a-z]|style=/i);
    }
    expect(markdownImageSnippet("https://cdn.example/a.png", "Hero")).toBe("![Hero](https://cdn.example/a.png)");
    expect(markdownImageSnippet("https://cdn.example/a.png", "Hero")).not.toMatch(/<img/i);
  });

  it("wraps the current selection in Markdown markers", () => {
    expect(applyMarkdownInsert("hello", 0, 5, "bold").next).toBe("**hello**");
    expect(applyMarkdownInsert("", 0, 0, "h2", "Heading").next).toBe("## Heading");
    expect(applyMarkdownInsert("body", 4, 4, "bulletList").next).toBe("body\n\n- ");
    expect(applyMarkdownInsert("body", 4, 4, "codeFence").next).toBe("body\n\n```\n\n```");
  });
});

describe("renderMarkdownPreview", () => {
  it("renders headings, emphasis, lists, links, fences, and images", () => {
    const html = renderMarkdownPreview([
      "# Title",
      "",
      "A **bold** _italic_ ~~strike~~ [link](https://example.com) and `code`.",
      "",
      "- one",
      "- two",
      "",
      "```",
      "const n = 1;",
      "```",
      "",
      "![alt](https://cdn.example/a.png)",
    ].join("\n"));
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del>strike</del>");
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<pre><code>const n = 1;");
    expect(html).toContain('<img src="https://cdn.example/a.png" alt="alt">');
  });

  it("escapes raw HTML and drops javascript URLs", () => {
    const html = renderMarkdownPreview('<script>alert(1)</script>\n[x](javascript:alert(1))\n![x](javascript:alert(1))');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
  });
});
