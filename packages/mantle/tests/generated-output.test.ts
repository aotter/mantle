/**
 * Generated-output compatibility baseline: one SHA-256 per (app, target, generated file) over the compositions
 * `match-target-fixture.ts` lists. The golden names every (app, target) pair that compiles, so a pair that stops
 * compiling, a new pair, a new or removed file, or any changed byte fails here. A slice may change only the digests it
 * declares (for example `access-targets.ts` when the target-hash formula changes, or a fixture it extends).
 * Regenerate with `UPDATE_GENERATED_OUTPUT=1 bun test tests/generated-output.test.ts` and review the diff.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Target } from "../src/domain/generation.js";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { apps } from "./match-target-fixture.js";

const GOLDEN = resolve(import.meta.dir, "generated-output.golden.json");
const targets: readonly Target[] = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"];
// Pairs of `apps()` that do not compile, with the reason; every other pair must compile and is pinned in the golden.
const excluded: Record<string, string> = {
  "club-events bun-postgres": "json_set() is SQLite-only",
  "club-events cloudflare-postgres": "json_set() is SQLite-only",
  "orders bun-postgres": "json_each() is SQLite-only",
  "orders cloudflare-postgres": "json_each() is SQLite-only",
  "rest bun-sqlite": "CAST to jsonb needs the PostgreSQL dialect",
  "rest cloudflare-d1": "CAST to jsonb needs the PostgreSQL dialect",
  "sql-patterns bun-postgres": "json_set() is SQLite-only",
  "sql-patterns cloudflare-postgres": "json_set() is SQLite-only",
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

test("generated output is byte-identical for every compiling (app, target) pair", async () => {
  const digests: Record<string, Record<string, string>> = {},
    refused: string[] = [];
  for (const [name, sources] of await apps())
    for (const target of targets) {
      const pair = `${name} ${target}`,
        generated = await generateFromSources({ target, sources: { sources } });
      if (!generated.ok) {
        refused.push(pair);
        continue;
      }
      digests[pair] = Object.fromEntries(
        Object.keys(generated.files)
          .sort()
          .map(file => [file, sha256(generated.files[file]!)]),
      );
    }
  expect(refused.sort()).toEqual(Object.keys(excluded).sort());
  const actual = JSON.stringify(digests, null, 2) + "\n";
  if (process.env.UPDATE_GENERATED_OUTPUT) await writeFile(GOLDEN, actual);
  const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as typeof digests;
  expect(Object.keys(digests)).toEqual(Object.keys(golden));
  for (const pair of Object.keys(golden)) expect([pair, digests[pair]]).toEqual([pair, golden[pair]!]);
}, 300_000);
