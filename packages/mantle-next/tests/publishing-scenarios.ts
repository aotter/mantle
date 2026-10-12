/** Identical publishing checks on the official SQLite, D1 and PostgreSQL handles. */
import assert from "node:assert/strict";
import { user } from "./apps/fixtures.js";

export async function verifyPublishing(app: any, db: any): Promise<{ checks: number }> {
  const anonymous = { kind: "anonymous" }, staff = { ...user("staff"), role: "staff" }, system = { kind: "system", reason: "test" };
  const table = app.store(db, staff).collection("posts"), draft = await table.insert({ title: "Hello" });
  assert.equal(draft.status, "draft"); assert.equal(draft.published_at, null);
  assert.equal((await app.views["posts-public"](db, staff, {})).length, 0);
  for (const caller of [anonymous, user("reader")]) {
    assert.equal((await app.views["posts-staff"](db, caller, {})).length, 0);
    assert.equal(await app.store(db, caller).collection("posts").count(), 0);
  }
  assert.equal(await table.count(), 1);
  assert.equal((await app.views["posts-staff"](db, staff, {})).length, 1);
  assert.equal(await app.store(db, system).collection("posts").count(), 1);
  for (const set of [{ status: "published" }, { STATUS: "published" }, { published_at: "2026-01-01T00:00:00Z" }]) await assert.rejects(Promise.resolve(table.update(draft.id, set, { lock: 1 })), { code: "INPUT_VALIDATION_FAILED" });
  const transition = (verb: string, expectedVersion: number, caller: any = staff) => app.procedures[`posts.${verb}`](db, caller, { id: draft.id, expectedVersion });
  await assert.rejects(transition("publish", 1, anonymous), { code: "UNAUTHENTICATED" });
  await assert.rejects(transition("publish", 1, user("reader")), { code: "AUTH_DENIED" });
  await assert.rejects(transition("publish", 2), { code: "CONFLICT", message: /expectedVersion differs/ });
  await assert.rejects(app.procedures["posts.publish"](db, staff, { id: "missing", expectedVersion: 1 }), { code: "CONFLICT", message: /row is missing or excluded/ });
  assert.match((await transition("publish", 1)).results[0][0].published_at, /Z$/);
  assert.equal((await app.views["posts-public"](db, anonymous, {})).length, 1);
  assert.equal(await app.store(db, anonymous).collection("posts").count(), 1);
  const edited = await table.update(draft.id, { title: "Edited while published" }, { lock: 2 });
  assert.equal(edited.status, "published");
  const nullDate = await table.insert({ title: "Null publication date" });
  for (const order of ["asc", "desc"]) {
    const first = await table.find({ orderBy: "published_at", order, limit: 1 });
    assert.equal(first.rows[0].id, draft.id);
    const second = await table.find({ orderBy: "published_at", order, limit: 1, cursor: first.cursor });
    assert.equal(second.rows[0].id, nullDate.id);
    assert.equal(second.cursor, null);
  }
  await table.delete(nullDate.id, { lock: 1 });
  await assert.rejects(transition("publish", 3), { code: "CONFLICT" });
  await transition("unpublish", 3);
  assert.equal((await app.views["posts-public"](db, staff, {})).length, 0);
  await transition("archive", 4, system);
  await assert.rejects(transition("publish", 5), { code: "CONFLICT" });
  assert.equal((await table.findById(draft.id)).status, "archived");
  await assert.rejects(transition("unpublish", 5, anonymous), { code: "UNAUTHENTICATED" });
  await assert.rejects(transition("unpublish", 5, user("reader")), { code: "AUTH_DENIED" });
  await transition("unpublish", 5);
  assert.equal((await table.findById(draft.id)).status, "draft");
  assert.equal((await app.views["posts-public"](db, anonymous, {})).length, 0);
  await assert.rejects(transition("archive", 5), { code: "CONFLICT" });
  const deletable = await table.insert({ title: "Delete after publish" });
  await app.procedures["posts.publish"](db, staff, { id: deletable.id, expectedVersion: 1 });
  await table.delete(deletable.id, { lock: 2 });
  assert.equal(await table.findById(deletable.id), null);
  const incomplete = await table.insert({});
  await assert.rejects(app.procedures["posts.publish"](db, staff, { id: incomplete.id, expectedVersion: 1 }), { code: "CONFLICT" });
  assert.equal((await table.findById(incomplete.id)).status, "draft");
  await assert.rejects(app.procedures["posts.unpublish"](db, staff, { id: incomplete.id, expectedVersion: 1 }), { code: "CONFLICT", message: /status is not published/ });
  const publishedTime = edited.published_at;
  assert.equal(typeof publishedTime, "string");
  const scoped = await app.store(db, staff).collection("scoped_posts").insert({ title: "Scoped" });
  const foreignStaff = { ...user("foreign"), role: "staff" };
  assert.equal(await app.store(db, foreignStaff).collection("scoped_posts").count(), 0);
  await assert.rejects(app.procedures["scoped_posts.publish"](db, foreignStaff, { id: scoped.id, expectedVersion: 1 }), { code: "CONFLICT" });
  await app.procedures["scoped_posts.publish"](db, staff, { id: scoped.id, expectedVersion: 1 });
  assert.equal(await app.store(db, anonymous).collection("scoped_posts").count(), 0);
  await app.procedures["scoped_posts.archive"](db, staff, { id: scoped.id, expectedVersion: 2 });
  await assert.rejects(app.procedures["scoped_posts.unpublish"](db, foreignStaff, { id: scoped.id, expectedVersion: 3 }), { code: "CONFLICT" });
  await app.procedures["scoped_posts.unpublish"](db, staff, { id: scoped.id, expectedVersion: 3 });
  await assert.rejects(app.procedures["scoped_posts.publish"](db, staff, { id: scoped.id, expectedVersion: 3 }), { code: "CONFLICT" });
  assert.equal(Number((await app.store(db, staff).collection("scoped_posts").findById(scoped.id)).version), 4);
  const expiring = app.store(db, system).collection("expiring_posts");
  const expired = await expiring.insert({ title: "Expired", expiresat: "2000-01-01T00:00:00Z" });
  await assert.rejects(app.procedures["expiring_posts.publish"](db, system, { id: expired.id, expectedVersion: 1 }), { code: "CONFLICT" });
  const live = await expiring.insert({ title: "Live", expiresat: "2099-01-01T00:00:00Z" });
  assert.equal((await app.procedures["expiring_posts.publish"](db, system, { id: live.id, expectedVersion: 1 })).results[0][0].status, "published");
  return { checks: 43 };
}
