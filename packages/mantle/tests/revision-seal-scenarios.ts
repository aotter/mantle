import { userCaller as authenticatedAs } from "../src/kernel/user-caller.js";

const equal = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
const result = (run: () => Promise<unknown>) => run().then(() => "ok", (error: { code?: string; fields?: { kind?: string } }) => `${error.code}:${error.fields?.kind ?? ""}`);

/** Real caller writes before switch and after commit, plus atomic rollback, on every target. */
export async function verifyRevisionSeal(app: any, handlers: any, db: unknown) {
  const admin = authenticatedAs({ id: "editor", role: "admin" }), anonymous = { kind: "anonymous" };
  const store = app.store(db, admin, { handlers }), posts = store.collection("posts"), revisions = store.collection("post_revisions");
  const run = async (name: string, input: any) => store.procedures[name](name === "switch-revision" ? {
    expectedRevisionVersion: (await revisions.findById(input.revision))?.version ?? 1, ...input,
  } : input);
  for (const when of ["before-batch", "after-batch"] as const) for (const mutation of ["edit", "delete"] as const) {
    const slug = `${when}-${mutation}`, post = await posts.insert({ slug });
    const first = (await run("new-revision", { post: post.id })).results[0][0];
    await revisions.update(first.id, { title: "Title", summary: "Summary", body: "Old body" }, { lock: first.version });
    await run("switch-revision", { post: post.id, revision: first.id, expectedVersion: post.version });
    await run("posts.publish", { id: post.id, expectedVersion: (await posts.findById(post.id)).version });
    const next = (await run("new-revision", { post: post.id })).results[0][0];
    const candidate = await revisions.update(next.id, { body: "New body" }, { lock: next.version });
    const expectedVersion = (await posts.findById(post.id)).version;
    // A stale parent must roll back the seal and preserve the candidate's version on D1 too.
    equal(await result(() => run("switch-revision", { post: post.id, revision: next.id, expectedVersion: expectedVersion - 1 })), "CONFLICT:row");
    const rolledBack = await revisions.findById(next.id);
    equal([Boolean(rolledBack.sealed), rolledBack.version], [false, candidate.version]);
    const change = () => mutation === "edit"
      ? revisions.update(next.id, { body: "Changed after preview" }, { lock: candidate.version })
      : run("prune-revision", { id: next.id });
    let mutationResult: string | undefined;
    if (when === "before-batch") mutationResult = await result(change);
    const switchResult = await result(() => run("switch-revision", { post: post.id, revision: next.id, expectedVersion, expectedRevisionVersion: candidate.version }));
    if (when === "after-batch") mutationResult = await result(change);
    equal([mutationResult, switchResult], when === "before-batch"
      ? ["ok", mutation === "delete" ? "INPUT_VALIDATION_FAILED:" : "CONFLICT:row"] : ["CONFLICT:lock", "ok"]);
    equal((await app.views["post-page"](db, anonymous, { slug })).map((row: any) => row.body), [when === "before-batch" ? "Old body" : "New body"]);
    const historical = await revisions.findById(first.id);
    equal(await result(() => revisions.update(first.id, { sealed: false }, { lock: historical.version })), "CONFLICT:lock");
  }
}

/** The exact recipe's handler joins an outer transaction and cannot commit a caught failed batch. */
export async function verifyRevisionTransaction(app: any, handlers: any, db: unknown) {
  const caller = authenticatedAs({ id: "editor", role: "admin" });
  const store = app.store(db, caller, { handlers });
  const posts = store.collection("posts"), revisions = store.collection("post_revisions");
  const post = await posts.insert({ slug: "transaction-" + crypto.randomUUID() });
  const create = async () => {
    const row = (await store.procedures["new-revision"]({ post: post.id })).results[0][0];
    return revisions.update(row.id, { title: "Title", summary: "Summary", body: "Reviewed body" }, { lock: row.version });
  };
  const first = await create();
  const input = { post: post.id, revision: first.id, expectedVersion: post.version, expectedRevisionVersion: first.version };
  const sentinel = Error("outer abort");
  try {
    await store.transaction(async (tx: any) => {
      await tx.procedures["switch-revision"](input);
      equal(Boolean((await tx.collection("post_revisions").findById(first.id)).sealed), true);
      throw sentinel;
    });
    throw Error("The outer transaction unexpectedly committed");
  } catch (error) { if (error !== sentinel) throw error; }
  equal((await posts.findById(post.id)).current_revision, null);
  equal([Boolean((await revisions.findById(first.id)).sealed), (await revisions.findById(first.id)).version], [false, first.version]);
  await store.transaction((tx: any) => tx.procedures["switch-revision"](input));
  equal((await posts.findById(post.id)).current_revision, first.id);
  const second = await create();
  equal(await result(() => store.transaction(async (tx: any) => {
    try { await tx.procedures["switch-revision"]({ ...input, revision: second.id, expectedRevisionVersion: second.version }); }
    catch { /* Application recovery cannot turn the partially executed batch into a committed seal. */ }
  })), "CONFLICT:row");
  equal((await posts.findById(post.id)).current_revision, first.id);
  equal([Boolean((await revisions.findById(second.id)).sealed), (await revisions.findById(second.id)).version], [false, second.version]);
}
