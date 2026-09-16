import { describe, expect, it } from "vitest";
import {
  isSafeHref,
  isSafeIframeSrc,
  isSafeImgSrc,
  sanitizeCssText,
  sanitizeHtml,
  videoEmbedHtml,
} from "../src/features/editor/html-sanitize";

describe("HTML URL allowlists", () => {
  it("accepts http(s), mailto, root-relative, and hash hrefs", () => {
    expect(isSafeHref("https://example.com/a")).toBe(true);
    expect(isSafeHref("/media/a.png")).toBe(true);
    expect(isSafeHref("#section")).toBe(true);
    expect(isSafeHref("mailto:ops@example.com")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,hi")).toBe(false);
  });

  it("accepts only http(s) or root-relative image sources", () => {
    expect(isSafeImgSrc("https://cdn.example/a.png")).toBe(true);
    expect(isSafeImgSrc("/a.png")).toBe(true);
    expect(isSafeImgSrc("javascript:alert(1)")).toBe(false);
    expect(isSafeImgSrc("data:image/png;base64,abc")).toBe(false);
  });

  it("accepts only YouTube and Dailymotion embed iframes", () => {
    expect(isSafeIframeSrc("https://www.youtube.com/embed/abc")).toBe(true);
    expect(isSafeIframeSrc("https://www.dailymotion.com/embed/video/x1")).toBe(true);
    expect(isSafeIframeSrc("https://example.com/embed/abc")).toBe(false);
    expect(isSafeIframeSrc("https://www.youtube.com/watch?v=abc")).toBe(false);
  });
});

describe("sanitizeCssText", () => {
  it("keeps alignment and simple colors, dropping expressions", () => {
    expect(sanitizeCssText("text-align:center; color: #111; background: url(x)")).toBe(
      "text-align: center; color: #111",
    );
    expect(sanitizeCssText("color: expression(alert(1))")).toBe("");
  });
});

describe("sanitizeHtml", () => {
  it("keeps formatting tags and drops scripts, handlers, and bad URLs", () => {
    expect(sanitizeHtml("<p>Hello <strong>there</strong></p>")).toBe("<p>Hello <strong>there</strong></p>");
    expect(sanitizeHtml(`<p onclick="alert(1)">Hi</p>`)).toBe("<p>Hi</p>");
    expect(sanitizeHtml("<script>alert(1)</script><p>ok</p>")).toBe("<p>ok</p>");
    expect(sanitizeHtml(`<img src="https://cdn.example/a.png" onerror="alert(1)">`)).toBe(
      `<img src="https://cdn.example/a.png">`,
    );
    expect(sanitizeHtml(`<a href="javascript:alert(1)">x</a>`)).toBe("<a>x</a>");
    expect(sanitizeHtml(`<iframe src="https://evil.example/embed"></iframe>`)).toBe("");
    expect(sanitizeHtml(`<iframe src="https://www.youtube.com/embed/abc"></iframe>`)).toBe(
      `<iframe src="https://www.youtube.com/embed/abc"></iframe>`,
    );
  });
});

describe("videoEmbedHtml", () => {
  it("emits YouTube embed iframes", () => {
    expect(videoEmbedHtml("https://www.youtube.com/watch?v=abc123")).toContain(
      "https://www.youtube.com/embed/abc123",
    );
  });
});
