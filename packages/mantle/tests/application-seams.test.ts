/**
 * Protected application seams (application-seams.ts). Each seam's hand-written consumer module is checked for the shape
 * of application code (public subpaths that resolve to dist, no casts), typechecked against the built package on every
 * stack it applies to, and executed where it runs:
 * - bun-sqlite on real bun:sqlite;
 * - cloudflare-d1 on the D1 stand-in over bun:sqlite (tests/apps/d1-shim.ts), not workerd;
 * - cloudflare-postgres with postgres.js and bun-postgres with Bun.SQL, both under Bun, against
 *   MANTLE_NEXT_WORKER_PG_URL / MANTLE_NEXT_BUN_PG_URL (set in PR CI; locally `pnpm with-pg`). Without them those runs
 *   are skipped and the test prints which seams did not run. workerd and Hyperdrive coverage is in verify-native.
 * A failure names the seam, the registry and the rule.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { Database } from "bun:sqlite";
import postgres from "postgres";
import ts from "typescript";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { d1Shim } from "./apps/d1-shim.js";
import { SEAMS, STACKS, type Seam, type Stack } from "./application-seams.js";
import { consumerProblems } from "./application-seams-guard.js";
import pinned from "./application-seams.ids.json";

const REGISTRY = "packages/mantle/tests/application-seams.ts";
const root = resolve(import.meta.dir, "../../..");
const core = SEAMS.filter(seam => seam.package === "@aotter/mantle");
const guard = (seams: readonly Pick<Seam, "id">[], problem: string) =>
  `${seams.map(seam => seam.id).join(", ")}: protected application seam (registry: ${REGISTRY}). ${problem}\n` +
  'Removing, moving or narrowing a registered seam needs an ADR or ADR-lite and a migration note (CONTRIBUTING.md, "Application seams").';
/** The stacks a seam is checked on: a seam with no database once, on the first. */
const stacksOf = (seam: Seam): readonly Stack[] => (seam.stacks.length ? seam.stacks : [STACKS[0]]);
const moduleOf = (seam: Seam, stack: Stack) => seam.stackChecks?.[stack] ?? seam.check;
const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  types: ["node", "bun-types"],
  typeRoots: [resolve(import.meta.dir, "../node_modules/@types"), resolve(import.meta.dir, "../node_modules")],
};

let dir = "";
/** Each copied consumer module and the seams it checks. */
const copies = new Map<string, Seam[]>();
beforeAll(async () => {
  await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });
  dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/seams-"));
  const sources = await loadFixtureSources("seams.yaml");
  for (const stack of STACKS) {
    // unlinked: generated code and the seam modules import @aotter/mantle/* through the exports map, as an application does
    await writeGenerated(resolve(dir, stack, "generated"), await generateOrThrow(stack, sources), false);
    for (const seam of core.filter(seam => stacksOf(seam).includes(stack))) {
      const copy = resolve(dir, stack, basename(moduleOf(seam, stack)));
      await copyFile(resolve(root, moduleOf(seam, stack)), copy);
      copies.set(copy, [...(copies.get(copy) ?? []), seam]);
    }
  }
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("the registered seam ids are pinned", () => {
  const ids = SEAMS.map(seam => seam.id);
  const removed = pinned.filter(id => !ids.includes(id));
  if (removed.length)
    throw new Error(
      guard(
        removed.map(id => ({ id })),
        "It was removed from the registry.",
      ),
    );
  expect(ids.filter(id => !pinned.includes(id))).toEqual([]); // a new seam is added to application-seams.ids.json too
});

test("every registered seam is an exported subpath outside ./internal/ with its named exports", async () => {
  const exportsMap = JSON.parse(await readFile(resolve(import.meta.dir, "../package.json"), "utf8")).exports;
  for (const seam of core) {
    if (!seam.subpath) continue;
    const entry = exportsMap[seam.subpath];
    if (!entry || seam.subpath.startsWith("./internal/"))
      throw new Error(guard([seam], `${seam.subpath} is no longer a developer-API subpath of ${seam.package}.`));
    const module = await import(resolve(import.meta.dir, "..", typeof entry === "string" ? entry : entry.import));
    const missing = (seam.exports ?? []).filter(name => !(name in module));
    if (missing.length) throw new Error(guard([seam], `${seam.subpath} no longer exports ${missing.join(", ")}.`));
  }
});

test("each seam's application module imports public subpaths only, has no casts and typechecks on its stacks", () => {
  const failures = [...copies].flatMap(([file, seams]) => {
    const problems = consumerProblems(file, options);
    return problems.length
      ? [guard(seams, `Its application module is not plain application code:\n${problems.join("\n")}`)]
      : [];
  });
  const program = ts.createProgram([...copies.keys()], options);
  const byFile = new Map<string, string[]>();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const file = d.file?.fileName ?? "";
    byFile.set(file, [
      ...(byFile.get(file) ?? []),
      `${file.slice(dir.length + 1)} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
    ]);
  }
  for (const [file, texts] of byFile)
    failures.push(
      guard(
        copies.get(file) ?? [{ id: "(generated code)" }],
        `Its application module no longer typechecks:\n${texts.join("\n")}`,
      ),
    );
  expect(failures.join("\n\n")).toBe("");
}, 60_000);

test("the consumer-module guard refuses plumbing, escapes, computed imports and casts", async () => {
  const { writeFile } = await import("node:fs/promises");
  const cases: Record<string, string> = {
    plumbing: 'import { convert } from "@aotter/mantle/internal/surface";',
    unexported: 'import { x } from "@aotter/mantle/nonexistent";',
    escape: 'import { x } from "../../outside.js";',
    computed: 'const name = "@aotter/mantle/rest"; export const m = await import(name);',
    required: "const name = 'x'; export const m = require(name);",
    as: "export const n = (1 as\n   unknown);",
    angle: "export const n = <any>1;",
    annotation: "export let n: any = 1;",
    nonNull: "export const n = [1].pop()!;",
    nocheck: "// @ts-nocheck\nexport const n = 1;",
  };
  for (const [name, text] of Object.entries(cases)) {
    const file = resolve(dir, "cloudflare-d1", `guard-${name}.ts`);
    await writeFile(file, text);
    expect([name, consumerProblems(file, options).length > 0]).toEqual([name, true]);
  }
  const fine = resolve(dir, "cloudflare-d1", "guard-fine.ts");
  await writeFile(
    fine,
    'import { body } from "@aotter/mantle/rest";\nexport const s = ["a"] as const;\nexport { body };',
  );
  expect(consumerProblems(fine, options)).toEqual([]);
});

type Handle = { db: unknown; sql(text: string): Promise<Record<string, unknown>[]>; end(): Promise<unknown> | unknown };
const owner = async () =>
  (await import("@aotter/mantle/testing")).authenticatedAs({ id: "note-owner", role: "user" }, { scopes: ["mcp"] });
const generatedSchema = (stack: Stack) => readFile(resolve(dir, stack, "generated/schema.sql"), "utf8");
const urls: Record<Stack, string | undefined> = {
  "cloudflare-d1": "memory",
  "bun-sqlite": "memory",
  "cloudflare-postgres": process.env.MANTLE_NEXT_WORKER_PG_URL,
  "bun-postgres": process.env.MANTLE_NEXT_BUN_PG_URL,
};
async function open(stack: Stack): Promise<Handle> {
  if (stack === "cloudflare-d1" || stack === "bun-sqlite") {
    const sqlite = new Database(":memory:");
    sqlite.exec(await generatedSchema(stack));
    sqlite.exec("CREATE TABLE note_log (key INTEGER NOT NULL, title TEXT NOT NULL)");
    return {
      db: stack === "bun-sqlite" ? sqlite : d1Shim(sqlite),
      sql: async text => sqlite.query(text).all() as Record<string, unknown>[],
      end: () => sqlite.close(),
    };
  }
  const schema = "seams_" + crypto.randomUUID().replaceAll("-", "");
  const sql: any =
    stack === "bun-postgres"
      ? new SQL({ url: urls[stack]!, max: 1 })
      : postgres(urls[stack]!, { max: 1, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);
  await sql.unsafe(await generatedSchema(stack));
  return {
    db: sql,
    sql: async text => [...(await sql.unsafe(text, []))],
    end: async () => {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await (stack === "bun-postgres" ? sql.close() : sql.end({ timeout: 1 }));
    },
  };
}
/** Runs `body` and names the seams it exercises when it fails. */
const exercising = async (ids: readonly string[], body: () => Promise<void>) => {
  try {
    await body();
  } catch (error) {
    throw new Error(
      guard(
        core.filter(seam => ids.includes(seam.id)),
        `It no longer behaves as its application module expects: ${error instanceof Error ? error.message : error}`,
      ),
      { cause: error },
    );
  }
};
const apps = {
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  },
};
const rpc = async (
  serve: (request: Request, env: object) => Promise<Response | undefined>,
  method: string,
  params: object = {},
) => {
  const response = await serve(
    new Request("https://notes.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: apps } }),
    }),
    {},
  );
  const text = await response!.text();
  return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text).result;
};

for (const stack of STACKS) {
  const runs = core.filter(seam => seam.run !== false && seam.stacks.includes(stack)).map(seam => seam.id);
  if (!urls[stack])
    console.warn(
      `application seams NOT RUN on ${stack} (no ${stack === "bun-postgres" ? "MANTLE_NEXT_BUN_PG_URL" : "MANTLE_NEXT_WORKER_PG_URL"}): ${runs.join(", ")}`,
    );
  (urls[stack] ? test : test.skip)(
    `${stack}: the application seams run (${runs.join(", ")})`,
    async () => {
      const module = (name: string) => import(pathToFileURL(resolve(dir, stack, name)).href);
      const caller = await owner();
      const { db, sql, end } = await open(stack);
      try {
        await exercising(["json-body", "origin-rule-and-errors", "call-tool"], async () => {
          const { addNoteRoute } = await module("own-route.ts");
          const post = (body: string, origin = "https://notes.example") =>
            addNoteRoute(
              new Request("https://notes.example/notes", {
                method: "POST",
                headers: { origin, "content-type": "application/json" },
                body,
              }),
              db,
              caller,
            );
          const added = await post('{"title":"First","tags":["a"]}');
          expect(added.status).toBe(200);
          expect((await added.json()).results[0][0]).toMatchObject({ title: "First", body: null });
          const large = await post(JSON.stringify({ title: "x".repeat(4096) }));
          expect(large.status).toBe(400);
          expect((await large.json()).error).toMatchObject({ code: "INPUT_VALIDATION_FAILED", path: "note-form" });
          const foreign = await post('{"title":"Second"}', "https://elsewhere.example");
          expect(foreign.status).toBe(403);
          expect((await foreign.json()).error.path).toBe("request:origin");
        });
        await exercising(["input-conversion"], async () => {
          const { addNoteInput } = await module("direct-call.ts");
          const input = addNoteInput({ title: "Direct", tags: ["b", "c"] });
          expect(input).toEqual({ title: "Direct", body: null, tags: '["b","c"]' });
          // the converted input is what the generated Procedure binds on this stack
          const { procedures } = await module("generated/generated.ts");
          const { results } = await procedures["add-note"](db, caller, input);
          expect(results[0][0]).toMatchObject({ title: "Direct", body: null });
        });
        await exercising(["own-tools", "app-resource-meta"], async () => {
          // a bearer caller, as a remote MCP client is: a cookie session's tool call also needs the origin rule
          const bearer = (await import("@aotter/mantle/testing")).authenticatedAs(
            { id: "note-owner", role: "user" },
            { scopes: ["mcp"], credential: "oauth" },
          );
          const serve = (await module("own-tools.ts")).serveMcp(db, bearer);
          const { tools } = await rpc(serve, "tools/list");
          expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["add_note", "note_summary"]);
          const summary = tools.find((tool: { name: string }) => tool.name === "note_summary");
          expect(summary._meta).toMatchObject({ "example/listing": { kind: "summary" } });
          const called = await rpc(serve, "tools/call", { name: "note_summary", arguments: {} });
          expect(called.structuredContent).toEqual({ notes: 0 });
          expect(called._meta).toMatchObject({ "example/view": { compact: true } });
          const read = await rpc(serve, "resources/read", { uri: "ui://notes/summary" });
          expect(read.contents[0]._meta).toMatchObject({ "example/host": { border: false } });
        });
        if (runs.includes("transaction-handle"))
          await exercising(["transaction-handle"], async () => {
            const { addNotesLocked } = await module(
              basename(moduleOf(core.find(s => s.id === "transaction-handle")!, stack)),
            );
            await addNotesLocked(db, caller, 7, "Locked");
            const rows = await sql("SELECT title FROM notes WHERE title LIKE 'Locked%' ORDER BY title");
            expect(rows.map(row => row.title)).toEqual(["Locked", "Locked (copy)"]);
            if (stack === "bun-sqlite")
              expect(await sql("SELECT key, title FROM note_log")).toEqual([{ key: 7, title: "Locked" }]);
          });
      } finally {
        await end();
      }
    },
    60_000,
  );
}
