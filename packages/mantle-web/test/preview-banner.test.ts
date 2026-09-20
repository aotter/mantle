import { describe, expect, it } from "vitest";
import {
  defaultPreviewBanner,
  injectPreviewBanner,
} from "../src/service/PreviewBanner.js";

describe("injectPreviewBanner", () => {
  it("inserts the banner immediately after <body>", () => {
    const html = injectPreviewBanner("<html><body><h1>x</h1></body></html>", "<div>P</div>");
    expect(html).toBe("<html><body><div>P</div><h1>x</h1></body></html>");
  });
  it("preserves attributes on the body tag", () => {
    const html = injectPreviewBanner(
      '<html><body class="dark" data-x="1"><h1>x</h1></body></html>',
      "<div>P</div>",
    );
    expect(html).toContain('<body class="dark" data-x="1"><div>P</div>');
  });
  it("returns input unchanged when no body tag exists", () => {
    const html = injectPreviewBanner("<div>fragment</div>", "<div>P</div>");
    expect(html).toBe("<div>fragment</div>");
  });
});

describe("defaultPreviewBanner", () => {
  it("interpolates status and slug into the default markup", () => {
    expect(defaultPreviewBanner("draft", "my-post")).toBe(
      `<div class="preview-banner">Preview · draft · my-post</div>`,
    );
  });

  it("escapes HTML in the slug — no reflected XSS via preview", () => {
    const html = defaultPreviewBanner("draft", `<script>alert(1)</script>`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes ampersand, quotes, and apostrophe", () => {
    const html = defaultPreviewBanner("draft", `"a'b&c"`);
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
    expect(html).toContain("&amp;");
  });
});
