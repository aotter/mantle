import { test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import ts from "typescript";
const root = resolve(import.meta.dir, "../src");
// auth and native hosts are optional application entries beside infrastructure.
// build is the private compiler: only generator layers (domain, usecase, infrastructure) may import it, never runtime code.
const ranks: Record<string, number> = { kernel: 0, build: 1, domain: 1, usecase: 2, auth: 3, bun: 3, infrastructure: 3 };
const compilerUsers = new Set(["build", "domain", "usecase", "infrastructure"]);
async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(path, entry.name)) : entry.name.endsWith(".ts") ? [resolve(path, entry.name)] : []))).flat();
}
test("Next imports point inward; kernel only imports transaction context from node", async () => {
  for (const file of await files(root)) {
    const layer = relative(root, file).split("/")[0]!;
    const parsed = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const name = statement.moduleSpecifier.text;
      if (name.startsWith(".")) {
        const imported = relative(root, resolve(dirname(file), name)).split("/")[0]!;
        if (imported === "..") expect(layer, `${file}: compiler assembly belongs to infrastructure`).toBe("infrastructure");
        else if (imported === "build") expect(compilerUsers.has(layer), `${file}: runtime code must not import the compiler`).toBe(true);
        else expect(ranks[imported] ?? Infinity, `${file}: ${name}`).toBeLessThanOrEqual(ranks[layer]!);
      } else if (layer === "kernel") {
        // Only transactional drivers need native async context to refuse outer-handle misuse without blocking other requests.
        expect(name, `${file}: kernel imports ${name}`).toBe("node:async_hooks");
        expect(relative(root, file)).toBe("kernel/driver/transaction-context.ts");
      }
    }
  }
}, 30_000); // parses every source file: slow under load
