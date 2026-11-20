import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";
import { Separator, Tabs, TabsContent, TabsList, TabsTrigger } from "../src/kit/index.js";

// An application that compiles Tailwind itself (README: tokens.css plus `@source` for the kit) does not load
// shadcn/tailwind.css, so `data-active:`, `data-open:` and the like are plain boolean `[data-active]` selectors that
// Radix never sets (it sets data-state and data-orientation). Compile the kit's classes without those variants.
const dir = resolve(import.meta.dirname, "../src/kit/components/ui");
const selectors = async (file: string) => {
  const tokens = readFileSync(resolve(dir, file), "utf8").match(/[^\s"'`]+/g)!;
  const css = (await compile("@tailwind utilities;")).build(tokens);
  return [...css.matchAll(/\[data-([\w-]+)(?:=(?:"([^"\]]*)"|([^"\]]*)))?\]/g)].map(m => ({
    name: m[1]!,
    value: m[2] ?? m[3],
  }));
};

test("no kit component styles on a boolean data variant that only a shadcn stylesheet would define", async () => {
  const dead = /^(active|open|closed|checked|unchecked|selected|horizontal|vertical|inset)$/;
  for (const file of readdirSync(dir)) {
    const found = (await selectors(file)).filter(s => s.value === undefined && dead.test(s.name));
    expect(
      found.map(s => s.name),
      file,
    ).toEqual([]);
  }
});

test("every data attribute Tabs and Separator style on is one the rendered parts carry", async () => {
  const markup = ["horizontal", "vertical"]
    .flatMap(orientation =>
      (["default", "line"] as const).map(variant =>
        renderToStaticMarkup(
          <Tabs defaultValue="a" orientation={orientation as "horizontal" | "vertical"}>
            <TabsList variant={variant}>
              <TabsTrigger value="a">A</TabsTrigger>
              <TabsTrigger value="b">B</TabsTrigger>
            </TabsList>
            <TabsContent value="a">x</TabsContent>
          </Tabs>,
        ),
      ),
    )
    .concat(renderToStaticMarkup(<Separator />), renderToStaticMarkup(<Separator orientation="vertical" />))
    .join("")
    .replace(/ class="[^"]*"/g, "");
  for (const file of ["tabs.tsx", "separator.tsx"]) {
    const found = await selectors(file);
    expect(found.length, file).toBeGreaterThan(0);
    for (const { name, value } of found)
      expect(markup, `${file}: [data-${name}${value === undefined ? "" : `=${value}`}]`).toContain(
        value === undefined ? ` data-${name}` : `data-${name}="${value}"`,
      );
  }
});

test("Tabs passes its orientation to Radix, so the list and triggers carry it", () => {
  const html = renderToStaticMarkup(
    <Tabs defaultValue="a" orientation="vertical">
      <TabsList>
        <TabsTrigger value="a">A</TabsTrigger>
      </TabsList>
    </Tabs>,
  );
  expect(html.match(/data-orientation="vertical"/g)).toHaveLength(3);
  expect(html).not.toContain('data-orientation="horizontal"');
});
