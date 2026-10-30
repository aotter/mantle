import { expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execute, prepareRevisionsExample } from "./fixtures/revisions-example";

it("the revisions recipe generates, checks and typechecks its exact custom Admin entries", async () => {
  const directory = await prepareRevisionsExample();
  try {
    const result = await execute(process.execPath, [resolve(import.meta.dirname, "../node_modules/typescript/bin/tsc"), "--noEmit", "-p", directory], { cwd: directory });
    expect(result.stderr).toBe("");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
