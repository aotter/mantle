import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../admin/mcp-styles.css"), "utf8");
const doc = readFileSync(resolve(import.meta.dirname, "../../../docs/handbook/guides/mcp-apps.md"), "utf8");
const names = (text: string) => [...text.matchAll(/`(--[\w-]+)`/g)].map(m => m[1]!);
const lines = (map: [string, string][]) => map.map(([host, token]) => `${host} -> ${token}`).sort();
const theme = /@theme inline \{([\s\S]*?)\n\}/.exec(css)![1]!;
/** `--color-x: var(--host-variable, fallback)`: a host variable has a fallback; the application's token has none. */
const hosted = [...theme.matchAll(/^\s*(--[\w-]+):\s*var\((--[\w-]+),/gm)].map(m => [m[2]!, m[1]!] as [string, string]);

test("the documented host variable mapping is the one mcp-styles.css makes", () => {
  const rows = doc.split("\n### Theme\n")[1]!.split("\n\n").find(part => part.startsWith("| Host variable"))!.split("\n").slice(2);
  const documented: [string, string][] = [];
  for (const row of rows) {
    const [host, tokens] = row.split("|").slice(1, 3).map(names);
    for (const token of tokens!) documented.push([host![0]!, token]);
  }
  expect(lines(documented)).toEqual(lines(hosted));
  expect(hosted.length).toBeGreaterThan(20);
});

test("brand colours read the application's tokens, never a host variable", () => {
  const brand = [...theme.matchAll(/^\s*(--color-(?:primary|primary-foreground|chart-\d))\s*:\s*(.*);/gm)];
  expect(brand.length).toBe(7);
  for (const [, , value] of brand) expect(value).toMatch(/^var\(--(?:primary|primary-foreground|chart-\d)\)$/);
});

test("the dark: variant answers to .dark and to data-theme, which a host sets together", async () => {
  const variant = /@custom-variant dark .*;/.exec(css)![0];
  const out = (await compile(`${variant}\n@tailwind utilities;`)).build(["dark:underline"]);
  expect(out).toContain('[data-theme="dark"]');
  expect(out).toMatch(/\.dark\b/);
});
