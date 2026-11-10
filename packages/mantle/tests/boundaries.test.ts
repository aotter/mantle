import { test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import ts from "typescript";
// Folder reach is enforced by scripts/check-boundaries.mjs; this keeps the kernel's static imports package-free.
const root = resolve(import.meta.dir, "../src");
async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(path, entry.name)) : entry.name.endsWith(".ts") ? [resolve(path, entry.name)] : []))).flat();
}
test("kernel only imports transaction context from node", async () => {
  for (const file of await files(resolve(root, "kernel"))) {
    const parsed = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const name = statement.moduleSpecifier.text;
      if (name.startsWith(".")) continue;
      // Only transactional drivers need native async context to refuse outer-handle misuse without blocking other requests.
      expect(name, `${file}: kernel imports ${name}`).toBe("node:async_hooks");
      expect(relative(root, file)).toBe("kernel/driver/transaction-context.ts");
    }
  }
});
