import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const read = (...path: string[]) => readFileSync(resolve(import.meta.dirname, ...path), "utf8");
const tokens = read("../src/kit/styles/tokens.css");
const names = (css: string) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]!);
const block = (selector: RegExp) => { const m = new RegExp(`^(${selector.source})\\s*\\{([^}]*)\\}`, "m").exec(tokens); if (!m) throw new Error(`no ${selector} block`); return { selector: m[1]!, names: new Set(names(m[2]!)) }; };
const root = block(/:root/), dark = block(/\.dark[^{]*/);
const internal = (name: string) => name.startsWith("--mantle-") || name === "--chrome-glass";

test("the documented public tokens are the non-internal :root tokens", () => {
  const section = read("../../../docs/handbook/guides/admin-ui.md").split("\n## Theme\n")[1]!;
  const documented = [...section.matchAll(/^\| `(--[\w-]+)` \|/gm)].map(m => m[1]!);
  expect(new Set(documented).size, "a token is documented twice").toBe(documented.length);
  expect([...documented].sort()).toEqual([...root.names].filter(name => !internal(name)).sort());
});

test("dark values cover every :root token but the radius and internal palette, and add none", () => {
  expect([...dark.names].filter(name => !root.names.has(name))).toEqual([]);
  expect([...root.names].filter(name => !dark.names.has(name) && name !== "--radius" && !name.startsWith("--mantle-"))).toEqual([]);
});

test("dark tokens and the dark: variant answer to .dark and data-theme", () => {
  expect(dark.selector).toMatch(/\.dark/);
  expect(dark.selector).toContain('[data-theme="dark"]');
  for (const css of [read("../src/kit/styles/kit.css"), read("../../mantle-admin/admin/styles.css")]) {
    const variant = /@custom-variant dark \(([^\n]*)\);/.exec(css)![1]!;
    expect(variant).toContain(".dark *");
    expect(variant).toContain('[data-theme="dark"] *');
  }
});
