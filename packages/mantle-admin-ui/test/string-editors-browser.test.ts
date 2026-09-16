import { expect, it } from "vitest";
import { chromium } from "playwright";
import { createServer } from "vite";
import { resolve } from "node:path";

it("selects markdown, html, and richtext editors from x-mcp-hint", async () => {
  const server = await createServer({ configFile: resolve("vite.config.ts"), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      localStorage.setItem("cms.preference.language", "en");
      history.replaceState(null, "", "/admin/c/docs/doc-1/edit");
    });
    const collection = {
      name: "docs",
      title: "Docs",
      description: null,
      lifecycle: "publishing",
      hasTranslations: false,
      localized: false,
      parent: null,
      nav: null,
      translates: null,
      sortableFields: ["title"],
      filter: null,
      list: { primaryField: "title", columns: [] },
      schema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", title: "Title" },
          body: { type: "string", title: "Markdown body", "x-mcp-hint": "markdown" },
          html: { type: "string", title: "HTML body", "x-mcp-hint": "html" },
          notes: { type: "string", title: "Notes", "x-mcp-hint": "richtext" },
        },
      },
      uiSchema: null,
    };
    await page.route("**/admin/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace("/admin/api", "");
      return route.fulfill({
        json: path === "/me" ? { role: "owner", login: "owner" }
          : path === "/site" ? { brand: "Editors", title: "Editors", icons: [], locales: ["en"], canonicalLocale: "en" }
          : path === "/collections" ? { collections: [collection] }
          : path === "/operations" ? { operations: [] }
          : path === "/views-manifest" ? { views: [] }
          : path === "/entries/doc-1" ? {
            collection,
            entry: {
              id: "doc-1",
              collection: "docs",
              locale: null,
              status: "draft",
              version: 1,
              data: {
                title: "Privacy",
                body: "# Hello\n\n**world**",
                html: "<p>Hello <strong>HTML</strong></p>",
                notes: "line one\nline two",
              },
              updated_at: 1,
            },
            parentEntryId: null,
            related: [],
          }
          : {},
      });
    });
    await page.goto(new URL("/_mantle/admin/", server.resolvedUrls!.local[0]!).href);

    const markdown = page.locator('[data-string-editor="markdown"]');
    const html = page.locator('[data-string-editor="html"]');
    const richtext = page.locator('[data-string-editor="richtext"]');
    await markdown.waitFor();
    await html.waitFor();
    await richtext.waitFor();

    expect(await markdown.getByRole("toolbar", { name: "Markdown toolbar" }).count()).toBe(1);
    expect(await markdown.getByRole("button", { name: "Underline" }).count()).toBe(0);
    expect(await markdown.getByRole("button", { name: "Align left" }).count()).toBe(0);
    expect(await markdown.getByLabel("Markdown preview").innerText()).toContain("Hello");
    expect(await markdown.getByLabel("Markdown preview").locator("h1").innerText()).toBe("Hello");

    const markdownInput = markdown.getByRole("textbox", { name: "Markdown body" });
    await markdownInput.click();
    await page.keyboard.press("Control+A");
    await markdown.getByRole("button", { name: "Bold" }).click();
    const markdownValue = await markdownInput.inputValue();
    expect(markdownValue).toMatch(/\*\*/);
    expect(markdownValue).not.toMatch(/<strong>|<b>/i);

    expect(await html.getByRole("toolbar", { name: "HTML editor toolbar" }).count()).toBe(1);
    expect(await html.getByRole("button", { name: "Underline" }).count()).toBe(1);
    const htmlBox = html.locator('[contenteditable="true"]');
    expect(await htmlBox.getAttribute("aria-label")).toBe("HTML body");
    expect(await htmlBox.innerText()).toContain("HTML");
    await htmlBox.click();
    await page.keyboard.press("Control+A");
    await html.getByRole("button", { name: "Underline" }).click();
    expect(await htmlBox.innerHTML()).toMatch(/<u>|<span[^>]*underline/i);

    expect(await richtext.getByRole("toolbar").count()).toBe(0);
    expect(await richtext.getByRole("textbox", { name: "Notes" }).inputValue()).toBe("line one\nline two");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
  }
}, 30_000);
