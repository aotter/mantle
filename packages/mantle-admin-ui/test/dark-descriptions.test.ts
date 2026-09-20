import { expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { createServer } from "vite";
import { resolve } from "node:path";
import { Card, CardDescription } from "../src/components/ui/card";
import { Dialog, DialogDescription } from "../src/components/ui/dialog";
import { AlertDialog, AlertDialogDescription } from "../src/components/ui/alert-dialog";
import { CollapsibleDescription, PageHeader } from "../src/ui/page";

it("keeps primary descriptions readable in dark mode without changing light or metadata colors", async () => {
  const server = await createServer({ configFile: resolve("vite.config.ts"), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const markup = renderToStaticMarkup(h("main", { className: "bg-background text-foreground p-8 space-y-8" },
      h(Card, null, h(CardDescription, null, "Review the operation before continuing.")),
      h(Dialog, null, h(DialogDescription, null, "Select media to attach to this entry.")),
      h(AlertDialog, null, h(AlertDialogDescription, null, "This operation cannot be undone.")),
      h(PageHeader, { title: "Library", description: "Review assets before deleting them." }),
      h(CollapsibleDescription, {
        description: "Schema notes that mention a `field` so the long copy collapses.",
        summaryLabel: "Details",
        collapsedIntro: "This collection stores published entries.",
      }),
      h("small", { className: "text-muted-foreground" }, "Updated yesterday"),
    ));
    await page.route("**/contrast-test", route => route.fulfill({ contentType: "text/html", body:
      '<link rel="stylesheet" href="/_mantle/admin/src/styles/global.css?direct">' + markup }));
    await page.goto(new URL("/contrast-test", server.resolvedUrls!.local[0]!).href);
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
      const colors = await page.evaluate(() => ({
        primary: getComputedStyle(document.querySelector("main")!).color,
        secondary: getComputedStyle(document.querySelector("small")!).color,
        descriptions: [...document.querySelectorAll('[data-slot$="description"]')].map(el => getComputedStyle(el).color),
      }));
      expect(colors.descriptions).toHaveLength(6);
      expect(colors.primary).not.toBe(colors.secondary);
      for (const color of colors.descriptions) expect(color).toBe(dark ? colors.primary : colors.secondary);
    }
  } finally { await browser.close(); await server.close(); }
}, 30_000);
