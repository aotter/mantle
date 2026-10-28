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
