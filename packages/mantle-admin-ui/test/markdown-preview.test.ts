import { describe, expect, it } from "vitest";
import { renderMarkdownPreview, safePreviewUrl } from "../src/features/editor/markdown-preview";

describe("renderMarkdownPreview", () => {
  it("renders headings, emphasis, and GFM tables", () => {
    const html = renderMarkdownPreview("# Title\n\n**bold** and _italic_\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<h1>");
    expect(html).toContain("Title");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<table>");
  });

  it("escapes raw HTML instead of executing it", () => {
    const html = renderMarkdownPreview("Hello <script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("neutralizes javascript: links", () => {
    const html = renderMarkdownPreview("[x](javascript:alert(1))");
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });
});

describe("safePreviewUrl", () => {
  it("allows http(s), mailto, and relative paths", () => {
    expect(safePreviewUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safePreviewUrl("/privacy")).toBe("/privacy");
    expect(safePreviewUrl("#section")).toBe("#section");
    expect(safePreviewUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
  });

  it("rejects dangerous schemes", () => {
    expect(safePreviewUrl("javascript:alert(1)")).toBe("#");
    expect(safePreviewUrl("data:text/html,hi")).toBe("#");
  });
});
