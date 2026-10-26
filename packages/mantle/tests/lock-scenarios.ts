/** #1822: one oracle for every target that a Schema lock binds every caller's write but a system one. Also imported by the local D1 Worker. */
import { userCaller } from "../src/kernel/user-caller.js";

const m = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const proc = (name: string, sql: string) => m("Procedure", name, { title: name, input: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, body: { type: "string" }, rev: { type: "string" } } }, output: { type: "object" }, handler: { sql } });
export const lockManifest = [
  m("Schema", "posts", { title: "Posts", lifecycle: "operational", indexes: [["current_revision"]], schema: { type: "object", properties: { title: { type: "string" }, current_revision: { type: "string", "x-mantle-ref": "post_revisions" } } } }),
  m("Schema", "post_revisions", { title: "Revisions", lifecycle: "operational", lock: [{ name: "live_revision", on: ["update", "delete"], when: "EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = post_revisions.id)", message: "This revision is live. Create a new revision and switch to it." }], schema: { type: "object", properties: { body: { type: "string" } } } }),
  proc("add_revision", "INSERT INTO post_revisions (id, body) VALUES (input.id, input.body) RETURNING id"),
  proc("add_post", "INSERT INTO posts (id, title, current_revision) VALUES (input.id, 'post', input.rev) RETURNING id"),
  proc("switch_revision", "UPDATE posts SET current_revision = input.rev WHERE id = input.id RETURNING id"),
  proc("edit_revision", "UPDATE post_revisions SET body = input.body WHERE id = input.id RETURNING id"),
  proc("prune_revision", "DELETE FROM post_revisions r WHERE r.id = input.id RETURNING id"),
].join("\n---\n");

export const member = userCaller({ id: "u" }), admin = userCaller({ id: "a", role: "admin" }, { adminRoles: ["admin"] }), system = { kind: "system", reason: "maintenance" } as const;
const equal = (actual: unknown, expected: unknown, what: string) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
/** A write's outcome: "ok", or the error's code and `kind`. */
export const outcome = (run: () => PromiseLike<unknown>) => Promise.resolve().then(run).then(() => "ok", (e: { code?: string; fields?: { kind?: string } }) => e.fields?.kind ? `${e.code}:${e.fields.kind}` : e.code ?? String(e));

type Procedures = Record<string, (db: any, caller: any, input: object) => Promise<unknown>>;
/** Caller-mode SQL Procedures: the live revision is frozen for members and admins alike; a system caller and other revisions are not. */
export async function verifyLockedProcedures(procedures: Procedures, db: unknown, locked = "CONFLICT:row") {
  const call = (name: string, caller: unknown, input: object) => outcome(() => procedures[name]!(db, caller, { id: null, body: null, rev: null, ...input }));
  for (const id of ["r1", "r2"]) equal(await call("add_revision", member, { id, body: id }), "ok", `add ${id}`);
  equal(await call("add_post", member, { id: "p1", rev: "r1" }), "ok", "add the post");
  for (const caller of [member, admin]) {
    equal(await call("edit_revision", caller, { id: "r1", body: "x" }), locked, "an edit of the live revision");
    equal(await call("prune_revision", caller, { id: "r1" }), locked, "a delete of the live revision");
  }
  equal(await call("edit_revision", admin, { id: "r2", body: "draft" }), "ok", "an edit of another revision");
  equal(await call("edit_revision", system, { id: "r1", body: "fixed" }), "ok", "a system edit of the live revision");
  equal(await call("switch_revision", admin, { id: "p1", rev: "r2" }), "ok", "switch revisions");
  equal(await call("prune_revision", member, { id: "r1" }), "ok", "prune the old revision");
  equal(await call("prune_revision", member, { id: "r2" }), locked, "the new live revision is frozen");
}
