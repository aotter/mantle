/**
 * Protected application seams (application-seams.ts): each seam's hand-written consumer module is typechecked against
 * the built package, as an application imports it, on every production stack it applies to, and executed where the
 * seam has run-time behaviour: cloudflare-d1 over a bun:sqlite D1 stand-in, cloudflare-postgres (postgres.js) and
 * bun-postgres (Bun.SQL) against MANTLE_NEXT_WORKER_PG_URL / MANTLE_NEXT_BUN_PG_URL. A failure names the seam.
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

const REGISTRY = "packages/mantle/tests/application-seams.ts";
const root = resolve(import.meta.dir, "../../..");
const core = SEAMS.filter(seam => seam.package === "@aotter/mantle");
const guard = (seams: readonly Seam[], problem: string) =>
  `${seams.map(seam => seam.id).join(", ")}: protected application seam (registry: ${REGISTRY}). ${problem}\n` +
  'Removing, moving or narrowing a registered seam needs an ADR or ADR-lite and a migration note (CONTRIBUTING.md, "Application seams").';
/** Where a stack-free seam's module is typechecked: the first stack's directory. */
const stacksOf = (seam: Seam): readonly Stack[] => (seam.stacks.length ? seam.stacks : [STACKS[0]]);

let dir = "";
beforeAll(async () => {
  await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });
  dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/seams-"));
  const sources = await loadFixtureSources("seams.yaml");
  for (const stack of STACKS) {
    // unlinked: generated code and the seam modules import @aotter/mantle/* through the exports map, as an application does
    await writeGenerated(resolve(dir, stack, "generated"), await generateOrThrow(stack, sources), false);
    for (const seam of core.filter(seam => stacksOf(seam).includes(stack)))
      await copyFile(resolve(root, seam.check), resolve(dir, stack, basename(seam.check)));
  }
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("every registered seam is an exported, documented subpath with its named exports", async () => {
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

test("each seam's application module typechecks on the stacks it applies to, from public imports and without casts", async () => {
  const roots = core.flatMap(seam => stacksOf(seam).map(stack => resolve(dir, stack, basename(seam.check))));
  for (const file of new Set(roots)) {
    const source = await readFile(file, "utf8");
    const seams = core.filter(seam => basename(seam.check) === basename(file));
    if (/@aotter\/mantle\/internal\/|\bas (?:any|never|unknown)\b|@ts-(?:ignore|expect-error)/.test(source))
      throw new Error(guard(seams, `${basename(file)} must use public imports only and no casts.`));
  }
  const program = ts.createProgram([...new Set(roots)], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: ["node", "bun-types"],
    typeRoots: [resolve(import.meta.dir, "../node_modules/@types"), resolve(import.meta.dir, "../node_modules")],
  });
  const problems = new Map<string, string[]>();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const file = d.file?.fileName ?? "";
    const text = `${file.slice(dir.length + 1)} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    problems.set(basename(file), [...(problems.get(basename(file)) ?? []), text]);
  }
  const failures = [...problems].map(([file, texts]) =>
    guard(
      core.filter(seam => basename(seam.check) === file),
      `Its application module no longer typechecks:\n${texts.join("\n")}`,
    ),
  );
  expect(failures.join("\n\n")).toBe("");
}, 60_000);

type Handle = { db: unknown; end(): Promise<unknown> | unknown };
const owner = async () =>
  (await import("@aotter/mantle/testing")).authenticatedAs({ id: "note-owner", role: "user" }, { scopes: ["mcp"] });
const generatedSchema = (stack: Stack) => readFile(resolve(dir, stack, "generated/schema.sql"), "utf8");
const urls: Record<Stack, string | undefined> = {
  "cloudflare-d1": "memory",
  "cloudflare-postgres": process.env.MANTLE_NEXT_WORKER_PG_URL,
  "bun-postgres": process.env.MANTLE_NEXT_BUN_PG_URL,
};
async function open(stack: Stack): Promise<Handle> {
  if (stack === "cloudflare-d1") {
    const sqlite = new Database(":memory:");
    sqlite.exec(await generatedSchema(stack));
    return { db: d1Shim(sqlite), end: () => sqlite.close() };
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

for (const stack of STACKS)
  (urls[stack] ? test : test.skip)(
    `${stack}: the application seams run`,
    async () => {
      const module = (name: string) => import(pathToFileURL(resolve(dir, stack, name)).href);
      const caller = await owner();
      const { db, end } = await open(stack);
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
          const { serveMcp } = await module("own-tools.ts");
          const listed = await serveMcp(db, caller)(
            new Request("https://notes.example/mcp", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
            }),
            {},
          );
          const text = await listed.text();
          const tools = JSON.parse(text.startsWith("event:") ? text.split("data: ")[1].split("\n")[0] : text).result
            .tools;
          expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["add_note", "note_summary"]);
          expect(tools.find((tool: { name: string }) => tool.name === "note_summary")._meta).toMatchObject({
            "example/listing": { kind: "summary" },
          });
        });
        if (stack !== "cloudflare-d1")
          await exercising(["transaction-handle"], async () => {
            const { addNotesLocked } = await module("transaction.ts");
            await addNotesLocked(db, caller, 7, "Locked");
            const sql = db as { unsafe(text: string, values: unknown[]): Promise<{ title: string }[]> };
            const rows = await sql.unsafe("SELECT title FROM notes WHERE title LIKE 'Locked%' ORDER BY title", []);
            expect(rows.map(row => row.title)).toEqual(["Locked", "Locked (copy)"]);
          });
      } finally {
        await end();
      }
    },
    60_000,
  );
