import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../src/mcp-app/styles.css"), "utf8");
const doc = readFileSync(resolve(import.meta.dirname, "../../../docs/handbook/guides/mcp-apps.md"), "utf8");
const names = (text: string) => [...text.matchAll(/`(--[\w-]+)`/g)].map(m => m[1]!);
const lines = (map: [string, string][]) => map.map(([host, token]) => `${host} -> ${token}`).sort();

test("the documented host variable mapping is the one styles.css makes", () => {
  const theme = /@theme inline \{([\s\S]*?)\n\}/.exec(css)![1]!;
  const actual: [string, string][] = [];
  for (const [, name, host] of theme.matchAll(/^\s*(--[\w-]+):\s*var\((--[\w-]+),/gm)) {
    if (!host!.startsWith("--mantle-")) actual.push([host!, name!.replace(/^--color-/, "--")]);
  }
  const rows = doc.split("\n### Theme\n")[1]!.split("\n\n").find(part => part.startsWith("| Host variable"))!.split("\n").slice(2);
  const documented: [string, string][] = [];
  for (const row of rows) {
    const [host, tokens] = row.split("|").slice(1, 3).map(names);
    for (const token of tokens!) documented.push([host![0]!, token]);
  }
  expect(lines(documented)).toEqual(lines(actual));
  expect(actual.length).toBeGreaterThan(20);
});

test("the dark: variant and the dark palette answer to .dark and data-theme", () => {
  const variant = /@custom-variant dark \{([\s\S]*?)\n\}/.exec(css)![1]!;
  expect(variant).toContain('[data-theme="dark"]');
  expect(variant).toContain(".dark");
  expect(variant).toContain(":root:not([data-theme], .dark)");
  expect(css).toContain(':root[data-theme="dark"], :root.dark {');
});
