import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { userCaller } from "../src/kernel/user-caller.js";
import { generateOrThrow, link, loadFixtureSources, writeGenerated } from "./apps/link.js";

// docs/handbook/guides/revisions.md: its manifests are apps/revisions.yaml, and its handler and preview route run here as written.
const guidePath = resolve(import.meta.dir, "../../../docs/handbook/guides/revisions.md");
const blocks = (text: string, lang: string) => [...text.matchAll(new RegExp("^```" + lang + "\\n([\\s\\S]*?)^```$", "gm"))].map(match => match[1]!);
const documents = (text: string) => text.split(/\n---\n/).map(doc => doc.replace(/^(#.*\n)+/, "").trim());

test("the guide's manifests are the revisions fixture", async () => {
  const guide = await readFile(guidePath, "utf8");
  expect(blocks(guide, "yaml").flatMap(documents)).toEqual(documents((await loadFixtureSources("revisions.yaml"))[0]!.text));
});

/** Generates the fixture and writes the guide's handler (src/handlers.ts) and route (src/routes.ts) beside it. */
async function app(target: "bun-sqlite" | "bun-postgres") {
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

const code = (run: () => Promise<unknown>) => run().then(() => "ok", (e: { code?: string }) => e.code ?? String(e));

async function verifyRevisions(db: unknown, { generated, handlers, postRoutes }: Awaited<ReturnType<typeof app>>) {
  const admin = userCaller({ id: "editor", role: "admin" }, { adminRoles: ["admin"] }), member = userCaller({ id: "member" }, {});
  const anonymous = { kind: "anonymous" } as const, origin = "https://blog.test";
  const data = generated.store(db, admin, { handlers }), posts = data.collection("posts"), revisions = data.collection("post_revisions");
  const run = async (name: string, input: Record<string, unknown>) => data.procedures[name](input);
  const page = async (slug: string) => (await generated.views["post-page"](db, anonymous, { slug })).map((row: any) => row.body);
  const get = async (path: string, caller: unknown = anonymous) => {
    const response = (await postRoutes(new Request(origin + path), db, origin, async () => caller))!;
    return { status: response.status, text: await response.text(), robots: response.headers.get("x-robots-tag") };
  };
  const version = async (id: string) => Number((await posts.findById(id))!.version);
  const fill = async (id: string, fields: Record<string, string>) => revisions.update(id, fields, { lock: (await revisions.findById(id))!.version });

  // A draft post and its first revision. new-revision starts an empty one, which the switch refuses as incomplete.
  const hello = await posts.insert({ slug: "hello" });
  const first = (await run("new-revision", { post: hello.id })).results[0][0];
  expect(await revisions.findById(first.id)).toMatchObject({ post: hello.id, title: "", body: "" });
  expect(await code(() => run("switch-revision", { post: hello.id, revision: first.id, expectedVersion: hello.version }))).toBe("INPUT_VALIDATION_FAILED");
  await fill(first.id, { title: "Hello", summary: "The first post.", body: "Version one." });
  expect(await code(() => generated.store(db, member, { handlers }).procedures["switch-revision"]({ post: hello.id, revision: first.id, expectedVersion: hello.version }))).toBe("AUTH_DENIED");
  const switched = await run("switch-revision", { post: hello.id, revision: first.id, expectedVersion: hello.version });
  // PostgreSQL returns int8 as a string through the Store, so compare the number.
  expect({ ...switched, version: Number(switched.version) }).toMatchObject({ id: hello.id, version: Number(hello.version) + 1, current_revision: first.id });

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

  // new-revision copies the current revision; editing the copy leaves the public page alone.
  const second = (await run("new-revision", { post: hello.id })).results[0][0];
  expect(await revisions.findById(second.id)).toMatchObject({ post: hello.id, title: "Hello", summary: "The first post.", body: "Version one." });
  await fill(second.id, { body: "Version two." });
  expect(await page("hello")).toEqual(["Version one."]);

  // The preview renders the revision through the page's template, for admins only, noindex, with the post's canonical URL.
  const preview = await get(`/preview/${second.id}`, admin);
  expect([preview.status, preview.robots]).toEqual([200, "noindex"]);
  expect(preview.text).toContain("Version two.");
  expect(preview.text).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(preview.text).toContain(`<link rel="canonical" href="${origin}/posts/hello">`);
  for (const caller of [anonymous, member]) expect((await get(`/preview/${second.id}`, caller)).status).toBe(404);
  expect((await get("/preview/missing", admin)).status).toBe(404);
  expect(await code(() => generated.views["revision-preview"](db, member, { revision: second.id }))).toBe("AUTH_DENIED");

  // A stale version is CONFLICT and changes nothing; so does a revision of another post.
  const stale = Number(hello.version) + 1;
  expect(stale).toBeLessThan(await version(hello.id));
  expect(await code(() => run("switch-revision", { post: hello.id, revision: second.id, expectedVersion: stale }))).toBe("CONFLICT");
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

  // Rollback is a switch to an earlier revision.
  await run("switch-revision", { post: hello.id, revision: first.id, expectedVersion: await version(hello.id) });
  expect(await page("hello")).toEqual(["Version one."]);

  // Pruning refuses the current revision and deletes any other.
  expect(await code(() => run("prune-revision", { id: first.id }))).toBe("CONFLICT");
  expect(await code(() => run("prune-revision", { id: second.id }))).toBe("ok");
  expect(await revisions.findById(second.id)).toBeNull();
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
  } finally { db.close(); await rm(built.dir, { recursive: true, force: true }); }
});

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)("PostgreSQL: the revisions guide behaves as documented", async () => {
  const built = await app("bun-postgres"), db = new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }), schema = "revisions_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await db.unsafe(`CREATE SCHEMA ${schema}`); await db.unsafe(`SET search_path TO ${schema}`);
    await db.unsafe(built.files["schema.sql"]!);
    await verifyRevisions(db, built);
  } finally { await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await db.close(); await rm(built.dir, { recursive: true, force: true }); }
}, 30000);
