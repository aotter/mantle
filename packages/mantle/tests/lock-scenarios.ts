/** #1822: one oracle for every target that a Schema lock binds every caller's write but a system one. Also imported by the local D1 Worker. */
import { userCaller } from "../src/kernel/user-caller.js";

const m = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const proc = (name: string, sql: string) => m("Procedure", name, { title: name, input: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, body: { type: "string" }, rev: { type: "string" } } }, output: { type: "object" }, handler: { sql } });
export const lockManifest = [
  m("Schema", "posts", { title: "Posts", lifecycle: "operational", indexes: [["current_revision"]], schema: { type: "object", properties: { title: { type: "string" }, current_revision: { type: "string", "x-mantle-ref": "post_revisions" } } } }),
  m("Schema", "post_revisions", { title: "Revisions", lifecycle: "operational", lock: [{ name: "live_revision", on: ["update", "delete"], when: "EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = post_revisions.id)", message: "This revision is live. Create a new revision and switch to it." },
    // the same condition through an unaliased subquery: neither may be captured by a write's alias (`p`, `posts`)
    { name: "live_revision_unaliased", on: ["update", "delete"], when: "EXISTS (SELECT 1 FROM posts WHERE posts.current_revision = post_revisions.id)", message: "This revision is live." }], schema: { type: "object", properties: { body: { type: "string" } } } }),
  proc("add_revision", "INSERT INTO post_revisions (id, body) VALUES (input.id, input.body) RETURNING id"),
  proc("add_post", "INSERT INTO posts (id, title, current_revision) VALUES (input.id, 'post', input.rev) RETURNING id"),
  proc("switch_revision", "UPDATE posts SET current_revision = input.rev WHERE id = input.id RETURNING id"),
  proc("edit_revision", "UPDATE post_revisions SET body = input.body WHERE id = input.id RETURNING id"),
  proc("prune_revision", "DELETE FROM post_revisions r WHERE r.id = input.id RETURNING id"),
  proc("prune_as_p", "DELETE FROM post_revisions p WHERE p.id = input.id RETURNING id"),
  proc("edit_as_posts", "UPDATE post_revisions AS posts SET body = input.body WHERE posts.id = input.id RETURNING id"),
  proc("upsert_revision", "INSERT INTO post_revisions AS p (id, body) VALUES (input.id, input.body) ON CONFLICT (id) DO UPDATE SET body = input.body RETURNING id"),
  // an owner-scoped Schema: another owner's row is invisible, so its refusal stays the row conflict
  m("Schema", "notes", { title: "Notes", lifecycle: "operational", scope: "owner = auth.uid()", indexes: [["owner", "id"]], lock: [{ name: "pinned", on: ["update", "delete"], when: "pinned = 'yes'", message: "Unpin the note first." }], schema: { type: "object", required: ["owner"], properties: { owner: { type: "string" }, body: { type: "string" }, pinned: { type: "string" } } } }),
  proc("add_note", "INSERT INTO notes (body, pinned) VALUES (input.body, input.rev) RETURNING id"),
  proc("edit_note", "UPDATE notes SET body = input.body WHERE id = input.id RETURNING id"),
].join("\n---\n");

export const member = userCaller({ id: "u" }), other = userCaller({ id: "o" }), admin = userCaller({ id: "a", role: "admin" }, { adminRoles: ["admin"] }), system = { kind: "system", reason: "maintenance" } as const;
const equal = (actual: unknown, expected: unknown, what: string) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
/** A write's outcome: "ok", or the error's code and `kind`. */
export const outcome = (run: () => PromiseLike<unknown>) => Promise.resolve().then(run).then(() => "ok", (e: { code?: string; fields?: { kind?: string } }) => e.fields?.kind ? `${e.code}:${e.fields.kind}` : e.code ?? String(e));

type Procedures = Record<string, (db: any, caller: any, input: object) => Promise<any>>;
type App = { procedures: Procedures; store: (db: any, caller: any) => any };
const locked = "CONFLICT:lock";
/**
 * Caller-mode SQL Procedures and caller-bound Stores: the live revision is frozen for members and admins alike, and the refusal
 * names the lock; a system caller and other revisions are not bound; a row the caller cannot see stays the row conflict.
 */
export async function verifyLock({ procedures, store }: App, db: unknown) {
  const call = (name: string, caller: unknown, input: object) => outcome(() => procedures[name]!(db, caller, { id: null, body: null, rev: null, ...input }));
  for (const id of ["r1", "r2"]) equal(await call("add_revision", member, { id, body: id }), "ok", `add ${id}`);
  equal(await call("add_post", member, { id: "p1", rev: "r1" }), "ok", "add the post");
  for (const caller of [member, admin]) {
    equal(await call("edit_revision", caller, { id: "r1", body: "x" }), locked, "an edit of the live revision");
    equal(await call("prune_revision", caller, { id: "r1" }), locked, "a delete of the live revision");
    // a write alias that a lock's subquery also names (`p`, `posts`) cannot capture the lock's references
    equal(await call("prune_as_p", caller, { id: "r1" }), locked, "a delete aliased like the lock's subquery");
    equal(await call("edit_as_posts", caller, { id: "r1", body: "x" }), locked, "an update aliased like the lock's unaliased subquery");
  }
  // an upsert is a set op: a locked conflicting row is left unchanged and returns no row, like DO NOTHING
  equal((await procedures.upsert_revision!(db, admin, { id: "r1", body: "x", rev: null })).results[0].length, 0, "an upsert onto the live revision");
  equal((await procedures.upsert_revision!(db, admin, { id: "r2", body: "two" })).results[0].length, 1, "an upsert onto another revision");
  equal(await call("edit_revision", admin, { id: "r2", body: "draft" }), "ok", "an edit of another revision");
  equal(await call("edit_revision", system, { id: "r1", body: "fixed" }), "ok", "a system edit of the live revision");
  equal(await call("switch_revision", admin, { id: "p1", rev: "r2" }), "ok", "switch revisions");
  equal(await call("prune_revision", member, { id: "r1" }), "ok", "prune the old revision");
  equal(await call("prune_revision", member, { id: "r2" }), locked, "the new live revision is frozen");
  const note = (await procedures.add_note!(db, member, { id: null, body: "n", rev: "yes" })).results[0][0].id;
  equal(await call("edit_note", member, { id: note, body: "x" }), locked, "an edit of one's own pinned note");
  equal(await call("edit_note", other, { id: note, body: "x" }), "CONFLICT:row", "another owner's pinned note is invisible");

  // Stores bound to a caller (`store(db, caller)`, a ref handler's `ctx.store`)
  equal(await call("add_revision", member, { id: "r3", body: "r3" }), "ok", "add r3");
  const revisions = (caller: unknown) => store(db, caller).collection("post_revisions"), r2 = await revisions(admin).findById("r2"), r3 = await revisions(admin).findById("r3");
  for (const caller of [member, admin]) {
    equal(await outcome(() => revisions(caller).update("r2", { body: "x" }, { lock: r2.version })), locked, "a Store update of the live revision");
    equal(await outcome(() => revisions(caller).delete("r2", { lock: r2.version })), locked, "a Store delete of the live revision");
  }
  // a stale version on a locked row still names the lock: the lock is why it can never succeed
  equal(await outcome(() => revisions(admin).update("r2", { body: "x" }, { lock: r2.version + 7 })), locked, "a stale Store update of the live revision");
  equal(await outcome(() => revisions(admin).update("r3", { body: "x" }, { lock: r3.version + 7 })), "CONFLICT:row", "a stale Store update of an unlocked revision");
  equal(await outcome(() => revisions(admin).update("r3", { body: "edited" }, { lock: r3.version })), "ok", "a Store update of another revision");
  equal(await outcome(() => revisions(system).update("r2", { body: "fixed" }, { lock: r2.version })), "ok", "a system Store update of the live revision");
  const notes = (caller: unknown) => store(db, caller).collection("notes"), mine = await notes(member).findById(note);
  equal(await outcome(() => notes(member).delete(note, { lock: mine.version })), locked, "a Store delete of one's own pinned note");
  equal(await outcome(() => notes(other).delete(note, { lock: mine.version })), "CONFLICT:row", "a Store delete of another owner's pinned note");
}
