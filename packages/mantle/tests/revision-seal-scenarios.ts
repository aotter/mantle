import { userCaller as authenticatedAs } from "../src/kernel/user-caller.js";

const equal = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
const result = (run: () => Promise<unknown>) => run().then(() => "ok", (error: { code?: string; fields?: { kind?: string } }) => `${error.code}:${error.fields?.kind ?? ""}`);

/** The actual guide handler, interleaved at its seal and parent writes. No SQL or caller policy is replaced. */
export async function verifyRevisionSeal(app: any, handlers: any, db: unknown) {
  const admin = authenticatedAs({ id: "editor", role: "admin" }), anonymous = { kind: "anonymous" };
  const store = app.store(db, admin, { handlers }), posts = store.collection("posts"), revisions = store.collection("post_revisions");
  const run = (name: string, input: unknown) => store.procedures[name](input);
  for (const when of ["before-seal", "after-seal"] as const) for (const mutation of ["blank", "delete"] as const) {
    const slug = `${when}-${mutation}`, post = await posts.insert({ slug });
    const first = (await run("new-revision", { post: post.id })).results[0][0];
    await revisions.update(first.id, { title: "Title", summary: "Summary", body: "Old body" }, { lock: first.version });
    await run("switch-revision", { post: post.id, revision: first.id, expectedVersion: post.version });
    await run("posts.publish", { id: post.id, expectedVersion: (await posts.findById(post.id)).version });
    const next = (await run("new-revision", { post: post.id })).results[0][0];
    const candidate = await revisions.update(next.id, { body: "New body" }, { lock: next.version });
    const change = () => mutation === "blank"
      ? revisions.update(next.id, { title: "", summary: "", body: "" }, { lock: candidate.version })
      : run("prune-revision", { id: next.id });
    let mutationResult: string | undefined;
    const instrumented = { ...handlers, "switch-revision": (ctx: any, input: unknown) => handlers["switch-revision"]({ ...ctx, store: new Proxy(ctx.store, {
      get(store, key) {
        if (key !== "collection") return store[key];
        return (name: string) => new Proxy(store.collection(name), { get(collection, method) {
          if (method !== "update") return collection[method];
          return async (...args: any[]) => {
            if ((when === "before-seal" && name === "post_revisions") || (when === "after-seal" && name === "posts")) mutationResult = await result(change);
            return collection.update(...args);
          };
        } });
      },
    }) }, input) };
    const expectedVersion = (await posts.findById(post.id)).version;
    const switchResult = await result(() => app.store(db, admin, { handlers: instrumented }).procedures["switch-revision"]({ post: post.id, revision: next.id, expectedVersion }));
    equal([mutationResult, switchResult], when === "before-seal" ? ["ok", "CONFLICT:row"] : ["CONFLICT:lock", "ok"]);
    equal((await app.views["post-page"](db, anonymous, { slug })).map((row: any) => row.body), [when === "before-seal" ? "Old body" : "New body"]);
    if (when === "after-seal") {
      // An old selection remains immutable after switching away; it cannot be unsealed through caller paths.
      equal(await result(() => run("switch-revision", { post: post.id, revision: first.id, expectedVersion: post.version })), "CONFLICT:row");
      const historical = await revisions.findById(first.id);
      equal(await result(() => revisions.update(first.id, { sealed: false }, { lock: historical.version })), "CONFLICT:lock");
    }
  }
}
