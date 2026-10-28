// Local browser acceptance only: real generated Store, Admin routes and database; test controls never ship.
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { admin as createAdmin } from "../../src/server/index.js";
import { entries } from "../../src/server/entries.js";
import { admin as caller } from "../../tests/native/server-native-scenarios.js";
const directory = process.argv[2]!, db = new Database(":memory:");
const app = await import(join(directory, "generated/generated.ts"));
const { handlers } = await import(join(directory, "src/handlers.ts"));
const { adminBindings } = await import(join(directory, "generated/admin-bindings.ts"));
db.exec(await readFile(join(directory, "generated/schema.sql"), "utf8"));
const store = app.store(db, caller, { handlers });
const posts = store.collection("posts"), revisions = store.collection("post_revisions");
const post = await posts.insert({ slug: "hello" });
const create = async (title: string, body: string) => {
  const row = (await store.procedures["new-revision"]({ post: post.id })).results[0][0];
  return revisions.update(row.id, { title, summary: "Reviewed summary", body }, { lock: row.version });
};
const first = await create("Published title", "Published body");
await store.procedures["switch-revision"]({ post: post.id, revision: first.id, expectedVersion: post.version, expectedRevisionVersion: first.version });
await store.procedures["posts.publish"]({ id: post.id, expectedVersion: (await posts.findById(post.id)).version });
const second = await create("Candidate title", "Candidate body");
// The deep-linked post must work even when it is absent from the first list page.
for (let i = 0; i < 100; i++) await posts.insert({ slug: `filler-${i}` });
const bindings = adminBindings({ handlers });
const api = createAdmin(bindings.metadata, bindings.views, bindings.operations, { db: () => db, caller: () => caller, routes: entries(bindings.schemas, bindings.adapter) });
let uncertain = false;
const writes: unknown[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/test/state") return Response.json({ post: await posts.findById(post.id), first: await revisions.findById(first.id), second: await revisions.findById(second.id), writes });
  if (url.pathname === "/test/edit" && request.method === "POST") {
    const row = await revisions.findById(second.id);
    await revisions.update(second.id, { body: "Changed after preview" }, { lock: row.version });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/test/parent" && request.method === "POST") {
    const row = await posts.findById(post.id);
    await posts.update(post.id, { current_revision: first.id }, { lock: row.version });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/test/uncertain" && request.method === "POST") { uncertain = true; return Response.json({ ok: true }); }
  if (url.pathname === "/posts/hello") {
    const row = (await app.views["post-page"](db, { kind: "anonymous" }, { slug: "hello" }))[0];
    return row ? new Response(`<h1>${row.title}</h1><p>${row.body}</p>`, { headers: { "content-type": "text/html" } }) : new Response("Not found", { status: 404 });
  }
  if (url.pathname.startsWith("/admin/api/")) {
    const switching = request.method === "POST" && url.pathname.endsWith("/operations/switch-revision");
    if (switching) writes.push(await request.clone().json());
    const response = await api(request, {});
    if (switching && uncertain && response?.status === 200) {
      uncertain = false;
      return Response.json({ error: { code: "OUTCOME_UNKNOWN", message: "Test transport lost the successful response" } }, { status: 503 });
    }
    return response ?? new Response("Not found", { status: 404 });
  }
  const relative = url.pathname.slice("/admin/".length);
  if (/^[\w/-]+\.(?:js|css|svg|png)$/.test(relative)) {
    try {
      const mime = relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : relative.endsWith(".svg") ? "image/svg+xml" : "image/png";
      return new Response(await readFile(resolve(directory, "dist", relative)), { headers: { "content-type": mime } });
    } catch { return new Response("Not found", { status: 404 }); }
  }
  try { return new Response(await readFile(join(directory, "dist/index.html")), { headers: { "content-type": "text/html" } }); }
  catch { return new Response("Build pending", { status: 503 }); }
} });
console.log(JSON.stringify({ origin: server.url.origin, post: post.id, first: first.id, second: second.id }));
