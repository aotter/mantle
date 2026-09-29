import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR-0034 decision 3: no Worker parses SQL. The runtime imports the validator, so the validator
 * must not reach `libpg-query` (128 MiB of WASM memory) by any import path.
 */
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const PARSER = join(SRC, "spec/infrastructure/sql/PgQueryParser.ts");
const VALIDATOR = join(SRC, "spec/domain/service/SqlIrValidator.ts");

function walk(dir: string): string[] {
  // dot folders are tool scratch (wrangler bundles a Worker into .wrangler/tmp while other suites run), never source
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]!);

function localImport(from: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const ts = resolve(dirname(from), spec.replace(/\.js$/, ".ts"));
  if (existsSync(ts)) return ts;
  const index = resolve(dirname(from), spec.replace(/\.js$/, ""), "index.ts");
  return existsSync(index) ? index : undefined;
}

describe("SQL parser boundary", () => {
  it("only PgQueryParser.ts names libpg-query", () => {
    const users = walk(SRC).filter((f) => importsOf(f).includes("libpg-query"));
    expect(users.map((f) => relative(SRC, f))).toEqual(["spec/infrastructure/sql/PgQueryParser.ts"]);
  });

  it("the runtime's validator does not reach the parser, or anything outside kernel and domain", () => {
    const seen = new Set<string>();
    const todo = [VALIDATOR];
    while (todo.length) {
      const file = todo.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(file)) {
        expect(spec, `${relative(SRC, file)} imports a package`).toMatch(/^\./);
        const next = localImport(file, spec);
        if (next) todo.push(next);
      }
    }
    expect(seen.has(PARSER)).toBe(false);
    for (const f of seen) expect(relative(SRC, f)).toMatch(/^spec\/(kernel|domain)\//);
  });

  it("libpg-query is loaded dynamically, so re-exporting the compiler does not instantiate the WASM", () => {
    expect(readFileSync(PARSER, "utf8")).toMatch(/await import\("libpg-query"\)/);
    expect(readFileSync(PARSER, "utf8")).not.toMatch(/^import .* from "libpg-query"/m);
  });
});
