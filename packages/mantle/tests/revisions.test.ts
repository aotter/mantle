import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { userCaller } from "../src/kernel/user-caller.js";
import { generateOrThrow, link, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { verifyRevisionSeal } from "./revision-seal-scenarios.js";
import { verifyOnLocalD1 } from "./apps/local-d1.js";

// docs/handbook/guides/revisions.md: its manifests are apps/revisions.yaml, and its handler and preview route run here as written.
const guidePath = resolve(import.meta.dir, "../../../docs/handbook/guides/revisions.md");
const blocks = (text: string, lang: string) => [...text.matchAll(new RegExp("^```" + lang + "\\n([\\s\\S]*?)^```$", "gm"))].map(match => match[1]!);
const documents = (text: string) => text.split(/\n---\n/).map(doc => doc.replace(/^(#.*\n)+/, "").trim());

test("the guide's manifests are the revisions fixture", async () => {
  const guide = await readFile(guidePath, "utf8");
  expect(blocks(guide, "yaml").flatMap(documents)).toEqual(documents((await loadFixtureSources("revisions.yaml"))[0]!.text));
});

/** Generates the fixture and writes the guide's handler (src/handlers.ts) and route (src/routes.ts) beside it. */
async function app(target: "bun-sqlite" | "bun-postgres" | "cloudflare-d1") {
  const guide = await readFile(guidePath, "utf8"), code = blocks(guide, "ts");
  const files = await generateOrThrow(target, await loadFixtureSources("revisions.yaml"));
  await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/revisions-"));
  await writeGenerated(join(dir, "generated"), files);
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src/handlers.ts"), link(code.find(block => block.includes("export const handlers"))!));
  await writeFile(join(dir, "src/routes.ts"), link(code.find(block => block.includes("export async function postRoutes"))!));
  return {
    dir, files,
    generated: await import(join(dir, "generated/generated.ts")),
    handlers: (await import(join(dir, "src/handlers.ts"))).handlers,
    postRoutes: (await import(join(dir, "src/routes.ts"))).postRoutes,
  };
}

const code = (run: () => Promise<unknown>) => run().then(() => "ok", (e: { code?: string; errno?: string; fields?: { kind?: string } }) => e.errno === "40001" ? "SQLSTATE 40001" : e.fields?.kind ? `${e.code} ${e.fields.kind}` : e.code ?? String(e));

async function verifyRevisions(db: unknown, { generated, handlers, postRoutes }: Awaited<ReturnType<typeof app>>) {
  const admin = userCaller({ id: "editor", role: "admin" }, { adminRoles: ["admin"] }), member = userCaller({ id: "member" }, {});
  const anonymous = { kind: "anonymous" } as const, origin = "https://blog.test";
  const data = generated.store(db, admin, { handlers }), posts = data.collection("posts"), revisions = data.collection("post_revisions");
  // Test convenience: calls that do not exercise a stale preview explicitly observe the candidate just before submit.
  const run = async (name: string, input: Record<string, unknown>) => data.procedures[name](name === "switch-revision" ? {
    expectedRevisionVersion: (await revisions.findById(input.revision))?.version ?? 1, ...input,
  } : input);
  const page = async (slug: string) => (await generated.views["post-page"](db, anonymous, { slug })).map((row: any) => row.body);
  const get = async (path: string, caller: unknown = anonymous) => {
    const response = (await postRoutes(new Request(origin + path), db, origin, async () => caller))!;
    return { status: response.status, text: await response.text(), robots: response.headers.get("x-robots-tag") };
  };
  const version = async (id: string) => (await posts.findById(id))!.version;
  const fill = async (id: string, fields: Record<string, string>) => revisions.update(id, fields, { lock: (await revisions.findById(id))!.version });

  // A draft post and its first revision. new-revision starts an empty one, which the switch refuses as incomplete.
  const hello = await posts.insert({ slug: "hello" });
  const first = (await run("new-revision", { post: hello.id })).results[0][0];
  expect(await revisions.findById(first.id)).toMatchObject({ post: hello.id, title: "", body: "" });
  expect(await code(() => run("switch-revision", { post: hello.id, revision: first.id, expectedVersion: hello.version }))).toBe("INPUT_VALIDATION_FAILED");
  await fill(first.id, { title: "Hello", summary: "The first post.", body: "Version one." });
  expect(await code(() => generated.store(db, member, { handlers }).procedures["switch-revision"]({ post: hello.id, revision: first.id, expectedVersion: hello.version, expectedRevisionVersion: 2 }))).toBe("AUTH_DENIED");
  const switched = await run("switch-revision", { post: hello.id, revision: first.id, expectedVersion: hello.version });
  expect(switched).toEqual({ id: hello.id, version: hello.version + 1, current_revision: first.id });

  // A post without a revision cannot be published: current_revision is required.
  const empty = await posts.insert({ slug: "empty" });
  expect(await code(() => generated.procedures["posts.publish"](db, admin, { id: empty.id, expectedVersion: empty.version }))).toBe("CONFLICT row");
  expect((await posts.findById(empty.id))!.status).toBe("draft");

  // The public View shows nothing while the post is a draft, even with a current revision; publishing makes it live.
  expect(await page("hello")).toEqual([]);
  expect((await get("/posts/hello")).status).toBe(404);
  await generated.procedures["posts.publish"](db, admin, { id: hello.id, expectedVersion: await version(hello.id) });
  expect(await page("hello")).toEqual(["Version one."]);
  const published = (await posts.findById(hello.id))!.published_at;
  const live = await get("/posts/hello");
  expect([live.status, live.robots]).toEqual([200, null]);
  expect(live.text).toContain(`<link rel="canonical" href="${origin}/posts/hello">`);
  expect(live.text).not.toContain("noindex");

  // The sealed_revision lock freezes every selected revision for every caller: an edit or delete is CONFLICT kind lock.
  expect(await code(() => fill(first.id, { body: "Edited live." }))).toBe("CONFLICT lock");
  expect(await code(async () => revisions.delete(first.id, { lock: (await revisions.findById(first.id))!.version }))).toBe("CONFLICT lock");
  expect(await page("hello")).toEqual(["Version one."]);

  // new-revision copies the current revision; editing the copy leaves the public page alone.
  const second = (await run("new-revision", { post: hello.id })).results[0][0];
  expect(await revisions.findById(second.id)).toMatchObject({ post: hello.id, title: "Hello", summary: "The first post.", body: "Version one." });
  await fill(second.id, { body: "Version two." });
  expect(await page("hello")).toEqual(["Version one."]);

  // The preview renders the revision through the page's template, for admins only, noindex, with the post's canonical URL.
  const preview = await get(`/preview/${second.id}`, admin);
  expect([preview.status, preview.robots]).toEqual([200, "noindex"]);
  expect(preview.text).toContain("Version two.");
  expect(preview.text).toContain(`revision ${second.id}, version ${(await revisions.findById(second.id))!.version}`);
  expect(preview.text).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(preview.text).toContain(`<link rel="canonical" href="${origin}/posts/hello">`);
  for (const caller of [anonymous, member]) expect((await get(`/preview/${second.id}`, caller)).status).toBe(404);
  expect((await get("/preview/missing", admin)).status).toBe(404);
  expect(await code(() => generated.views["revision-preview"](db, member, { revision: second.id }))).toBe("AUTH_DENIED");

  // A stale version is CONFLICT and changes nothing; so does a revision of another post.
  const stale = hello.version + 1;
  expect(stale).toBeLessThan(await version(hello.id));
  expect(await code(() => run("switch-revision", { post: hello.id, revision: second.id, expectedVersion: stale }))).toBe("CONFLICT row");
  expect(Boolean((await revisions.findById(second.id))!.sealed)).toBe(false); // the batch rolls back the seal
  const observed = (await revisions.findById(second.id))!.version, currentVersion = await version(hello.id);
  await fill(second.id, { body: "Changed after preview." });
  expect(await code(() => run("switch-revision", { post: hello.id, revision: second.id, expectedVersion: currentVersion, expectedRevisionVersion: observed }))).toBe("CONFLICT row");
  expect(Boolean((await revisions.findById(second.id))!.sealed)).toBe(false);
  await fill(second.id, { body: "Version two." });
  const other = await posts.insert({ slug: "other" });
  const foreign = (await run("new-revision", { post: other.id })).results[0][0];
  await fill(foreign.id, { title: "Other", summary: "Another post.", body: "Not hello." });
  const current = await version(hello.id);
  expect(await code(() => run("switch-revision", { post: hello.id, revision: foreign.id, expectedVersion: current }))).toBe("INPUT_VALIDATION_FAILED");
  expect(await code(() => run("switch-revision", { post: hello.id, revision: "missing", expectedVersion: current }))).toBe("INPUT_VALIDATION_FAILED");
  expect(await page("hello")).toEqual(["Version one."]);

  // The switch with the version the editor saw goes live at once; the post stays published with its first publication time.
  await run("switch-revision", { post: hello.id, revision: second.id, expectedVersion: await version(hello.id) });
  expect(await page("hello")).toEqual(["Version two."]);
  expect(await posts.findById(hello.id)).toMatchObject({ status: "published", published_at: published, current_revision: second.id });
  expect((await get("/posts/hello")).text).toContain("Version two.");
  expect((await generated.views["published-posts"](db, anonymous, {})).map((row: any) => [row.slug, row.title])).toEqual([["hello", "Hello"]]);

  const afterSwitchVersion = await version(hello.id);
  // Even an immutable rollback target must match the explicitly observed version.
  expect(await code(() => run("switch-revision", { post: hello.id, revision: first.id, expectedVersion: afterSwitchVersion, expectedRevisionVersion: 1 }))).toBe("CONFLICT row");

  // Rollback is a switch to an earlier revision.
  await run("switch-revision", { post: hello.id, revision: first.id, expectedVersion: await version(hello.id) });
  expect(await page("hello")).toEqual(["Version one."]);

  // Both selected revisions remain sealed. Pruning can only remove an unsealed draft.
  expect(await code(() => fill(first.id, { body: "Edited live." }))).toBe("CONFLICT lock");
  expect(await code(() => run("prune-revision", { id: first.id }))).toBe("CONFLICT lock");
  expect(await code(() => run("prune-revision", { id: second.id }))).toBe("CONFLICT lock");
  expect(await code(() => fill(second.id, { body: "Rewrite history." }))).toBe("CONFLICT lock");
  const unused = (await run("new-revision", { post: hello.id })).results[0][0];
  expect(await code(() => run("prune-revision", { id: unused.id }))).toBe("ok");
  expect(await revisions.findById(unused.id)).toBeNull();
  expect(await page("hello")).toEqual(["Version one."]);

  // Unpublishing takes the page down; the preview still works for admins.
  await generated.procedures["posts.unpublish"](db, admin, { id: hello.id, expectedVersion: await version(hello.id) });
  expect(await page("hello")).toEqual([]);
  expect((await get("/posts/hello")).status).toBe(404);
  expect((await get(`/preview/${first.id}`, admin)).status).toBe(200);
}

test("bun:sqlite: the revisions guide behaves as documented", async () => {
  const built = await app("bun-sqlite"), db = new Database(":memory:");
  try {
    db.exec(built.files["schema.sql"]!);
    await verifyRevisions(db, built);
    await verifyRevisionSeal(built.generated, built.handlers, db);
  } finally { db.close(); await rm(built.dir, { recursive: true, force: true }); }
});

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)("PostgreSQL: the revisions guide behaves as documented", async () => {
  const built = await app("bun-postgres"), db = new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }), schema = "revisions_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await db.unsafe(`CREATE SCHEMA ${schema}`); await db.unsafe(`SET search_path TO ${schema}`);
    await db.unsafe(built.files["schema.sql"]!);
    await verifyRevisions(db, built);
    await verifyRevisionSeal(built.generated, built.handlers, db);
  } finally { await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await db.close(); await rm(built.dir, { recursive: true, force: true }); }
}, 30000);

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)("PostgreSQL: the same-row seal arbitrates writes whose snapshots precede the seal", async () => {
  const built = await app("bun-postgres"), url = process.env.MANTLE_NEXT_BUN_PG_URL!;
  const db = new SQL(url, { max: 1 }), competingDb = new SQL(url, { max: 1 }), gate = new SQL(url, { max: 1 });
  const schema = "seal_" + crypto.randomUUID().replaceAll("-", ""), admin = userCaller({ id: "editor", role: "admin" });
  const data = built.generated.store(db, admin, { handlers: built.handlers }), other = built.generated.store(competingDb, admin, { handlers: built.handlers });
  try {
    await db.unsafe(`CREATE SCHEMA ${schema}`);
    for (const handle of [db, competingDb]) await handle.unsafe(`SET search_path TO ${schema}`);
    await db.unsafe(built.files["schema.sql"]!);
    const [{ pid: switchPid }] = await db.unsafe("SELECT pg_backend_pid() AS pid");
    const [{ pid: editPid }] = await competingDb.unsafe("SELECT pg_backend_pid() AS pid");
    for (const sealFirst of [false, true]) for (const mutation of ["blank", "delete"]) {
      const slug = `race-${sealFirst}-${mutation}`, posts = data.collection("posts"), revisions = data.collection("post_revisions");
      const run = async (name: string, input: any) => data.procedures[name](name === "switch-revision" ? {
        expectedRevisionVersion: (await revisions.findById(input.revision))?.version ?? 1, ...input,
      } : input);
      const post = await posts.insert({ slug }), first = (await run("new-revision", { post: post.id })).results[0][0];
      await revisions.update(first.id, { title: "Title", summary: "Summary", body: "Old body" }, { lock: first.version });
      await run("switch-revision", { post: post.id, revision: first.id, expectedVersion: post.version });
      await run("posts.publish", { id: post.id, expectedVersion: (await posts.findById(post.id))!.version });
      const next = (await run("new-revision", { post: post.id })).results[0][0];
      const candidate = await revisions.update(next.id, { body: "New body" }, { lock: next.version });
      const expectedVersion = (await posts.findById(post.id))!.version;
      // Test-only trigger holds the first writer after WHERE admission and row locking. Every application write
      // remains a normal caller Store/Procedure write; the second writer must recheck seal/OCC on the changed row.
      await db.unsafe(`CREATE OR REPLACE FUNCTION pause_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' THEN ${sealFirst ? "" : "PERFORM pg_advisory_xact_lock(1845021);"} RETURN OLD; END IF;
        IF NEW.sealed = ${sealFirst ? "true" : "false"} THEN PERFORM pg_advisory_xact_lock(1845021); END IF; RETURN NEW; END $$`);
      await db.unsafe("CREATE TRIGGER pause_revision BEFORE UPDATE OR DELETE ON post_revisions FOR EACH ROW EXECUTE FUNCTION pause_revision()");
      await gate.unsafe("SELECT pg_advisory_lock(1845021)");
      const waiting = async (kind: string, pid?: number) => {
        for (let i = 0; i < 100; i++) {
          const rows = await gate.unsafe("SELECT 1 FROM pg_locks WHERE locktype = $1 AND NOT granted AND ($2::integer IS NULL OR pid = $2::integer)", [kind, pid ?? null]);
          if (rows.length) return;
          await new Promise(done => setTimeout(done, 10));
        }
        throw Error(`No waiting ${kind} lock`);
      };
      const switching = () => code(() => run("switch-revision", { post: post.id, revision: next.id, expectedVersion, expectedRevisionVersion: candidate.version }));
      const changing = () => code(() => mutation === "blank"
        ? other.collection("post_revisions").update(next.id, { title: "", summary: "", body: "" }, { lock: candidate.version })
        : other.procedures["prune-revision"]({ id: next.id }));
      const firstWrite = sealFirst ? switching() : changing();
      await waiting("advisory");
      const secondWrite = sealFirst ? changing() : switching();
      await waiting("transactionid", sealFirst ? editPid : switchPid);
      await gate.unsafe("SELECT pg_advisory_unlock(1845021)");
      expect(await firstWrite).toBe("ok");
      const loser = await secondWrite;
      if (sealFirst) expect(loser).toBe("CONFLICT lock");
      else expect(["CONFLICT row", "SQLSTATE 40001"]).toContain(loser);
      expect((await built.generated.views["post-page"](db, { kind: "anonymous" }, { slug })).map((row: any) => row.body)).toEqual([sealFirst ? "New body" : "Old body"]);
      if (!sealFirst && mutation === "blank") {
        const remaining = await revisions.findById(next.id);
        expect([Boolean(remaining.sealed), remaining.version]).toEqual([false, candidate.version + 1]);
      }
      await db.unsafe("DROP TRIGGER pause_revision ON post_revisions");
    }
  } finally {
    await gate.unsafe("SELECT pg_advisory_unlock_all()").catch(() => {});
    await competingDb.close(); await gate.close();
    await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await db.close();
    await rm(built.dir, { recursive: true, force: true });
  }
}, 30000);

(process.env.MANTLE_NEXT_REST_D1 ? test : test.skip)("local D1: sealing arbitrates candidate edits and deletes without an interactive transaction", async () => {
  const { unstable_splitSqlQuery } = await import("wrangler"), built = await app("cloudflare-d1");
  try {
    expect(await verifyOnLocalD1(built.dir, `import * as app from './generated/generated.ts';import {handlers} from './src/handlers.ts';import {verifyRevisionSeal} from ${JSON.stringify(resolve(import.meta.dir, "revision-seal-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(built.files["schema.sql"]!))})await env.DB.prepare(sql).run();await verifyRevisionSeal(app,handlers,env.DB);return Response.json({ok:true});}catch(error){return Response.json({error:String(error),stack:(error as Error).stack},{status:500});}}};`, process.env.MANTLE_NEXT_REVISIONS_D1_PORT ?? "8991")).toEqual({ ok: true });
  } finally { await rm(built.dir, { recursive: true, force: true }); }
}, 90000);
