import { test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import ts from "typescript";
const root = resolve(import.meta.dir, "../src");
const ranks: Record<string, number> = { kernel: 0, domain: 1, usecase: 2, infrastructure: 3 };
async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(path, entry.name)) : entry.name.endsWith(".ts") ? [resolve(path, entry.name)] : []))).flat();
}
test("Next imports point inward; kernel has no host or compiler dependencies", async () => {
  for (const file of await files(root)) {
    const layer = relative(root, file).split("/")[0]!;
    const parsed = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const name = statement.moduleSpecifier.text;
      if (name.startsWith(".")) {
        const imported = relative(root, resolve(dirname(file), name)).split("/")[0]!;
        if (imported === "..") expect(layer, `${file}: compiler assembly belongs to infrastructure`).toBe("infrastructure");
        else expect(ranks[imported] ?? Infinity, `${file}: ${name}`).toBeLessThanOrEqual(ranks[layer]!);
      } else if (layer === "kernel") {
        expect(["zod/mini", "zod/v4/locales/en.js"], `${file}: kernel must stay portable`).toContain(name);
      }
    }
  }
});
