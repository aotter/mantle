import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../src/mcp-app/styles.css"), "utf8");
const doc = readFileSync(resolve(import.meta.dirname, "../../../docs/handbook/guides/mcp-apps.md"), "utf8");
const names = (text: string) => [...text.matchAll(/`(--[\w-]+)`/g)].map(m => m[1]!);
const lines = (map: [string, string][]) => map.map(([host, token]) => `${host} -> ${token}`).sort();
const declarations = [...(/@theme inline \{([\s\S]*?)\n\}/.exec(css)![1]!).matchAll(/^\s*(--[\w-]+):\s*var\((--[\w-]+)[,)]/gm)].map(m => [m[1]!, m[2]!] as const);

test("the documented host variable mapping is the one styles.css makes", () => {
  const actual = declarations.filter(([, host]) => !host.startsWith("--mantle-")).map(([name, host]) => [host, name] as [string, string]);
  const rows = doc.split("\n### Theme\n")[1]!.split("\n\n").find(part => part.startsWith("| Host variable"))!.split("\n").slice(2);
  const documented: [string, string][] = [];
  for (const row of rows) {
    const [host, tokens] = row.split("|").slice(1, 3).map(names);
    for (const token of tokens!) documented.push([host![0]!, token]);
  }
  expect(lines(documented)).toEqual(lines(actual));
  expect(actual.length).toBeGreaterThan(20);
});

test("brand colors never read a host variable", () => {
  const brand = declarations.filter(([name]) => /^--color-(primary|primary-foreground|chart-\d)$/.test(name));
  expect(brand.length).toBeGreaterThan(0);
  for (const [, source] of brand) expect(source).toMatch(/^--mantle-/);
});

test("the compiled dark: variant answers to .dark and data-theme, and to the system only when the host sets no theme", async () => {
  const variant = /@custom-variant dark \{[\s\S]*?\n\}/.exec(css)![0];
  const out = (await compile(`${variant}\n@tailwind utilities;`)).build(["dark:underline"]);
  expect(out).toContain('[data-theme="dark"]');
  expect(out).toMatch(/\.dark\b/);
  expect(out).toContain("prefers-color-scheme: dark");
  expect(out).toContain(":not([data-theme], .dark)");
  expect(css).toContain(':root[data-theme="dark"], :root.dark {');
});
