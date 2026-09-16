import { describe, expect, it } from "vitest";
import { htmlImage, serializeHtml, videoEmbed } from "../src/features/editor/html-serialize";

describe("serializeHtml", () => {
  it("stores empty contenteditable markup as an empty string", () => {
    expect(serializeHtml("<br>")).toBe("");
    expect(serializeHtml("<p><br></p>")).toBe("");
    expect(serializeHtml("&nbsp;")).toBe("");
  });

  it("keeps real HTML fragments", () => {
    expect(serializeHtml("<p>Hello</p>")).toBe("<p>Hello</p>");
    expect(serializeHtml("<strong>Hi</strong>")).toBe("<strong>Hi</strong>");
  });
});

describe("htmlImage", () => {
  it("emits an img tag, not Markdown", () => {
    expect(htmlImage("https://cdn.example/a.png", 'Alt "x"')).toBe(
      '<img src="https://cdn.example/a.png" alt="Alt &quot;x&quot;" />',
    );
    expect(htmlImage("https://cdn.example/a.png", "Alt")).not.toMatch(/!\[[^\]]*]\(/);
  });
});

describe("videoEmbed", () => {
  it("embeds known providers as iframes", () => {
    expect(videoEmbed("https://www.youtube.com/watch?v=abc123")).toContain("youtube.com/embed/abc123");
    expect(videoEmbed("https://youtu.be/abc123")).toContain("youtube.com/embed/abc123");
    expect(videoEmbed("https://www.dailymotion.com/video/x123")).toContain("dailymotion.com/embed/video/x123");
  });

  it("falls back to an HTML anchor for unknown URLs", () => {
    const html = videoEmbed("https://example.com/watch");
    expect(html).toContain("<a href=");
    expect(html).not.toMatch(/!\[[^\]]*]\(/);
  });
});
