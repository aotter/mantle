/** One oracle for `handler.steps` with `onNoRows: conflict` (#1874) on every target. Also imported by the local D1 Worker. */
type Query = (sql: string) => Promise<Record<string, unknown>[]>;
const equal = (actual: unknown, expected: unknown, what: string) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
const code = (run: () => Promise<unknown>) => run().then(() => "ok", (e: { code?: string; fields?: { kind?: string } }) => e.code ? `${e.code}${e.fields?.kind ? `:${e.fields.kind}` : ""}` : String(e));

export async function verifyProcedureSteps(app: any, db: unknown, caller: unknown, rows: Query) {
  const client = await app.store(db, caller).collection("clients").insert({ name: "acme" });
  const count = async (table: string) => Number((await rows(`SELECT count(*) AS n FROM ${table}`))[0]!["n"]);

  // the parent is missing: nothing is written, and the call is CONFLICT kind "row" instead of an empty success
  equal(await code(() => app.procedures.add_contact(db, caller, { client: "missing", name: "ghost" })), "CONFLICT:row", "a missing parent");
  equal(await count("contacts"), 0, "nothing written for a missing parent");
  // the same statement without onNoRows: writing no row is a valid, empty result
  equal(await app.procedures.add_contact_or_nothing(db, caller, { client: "missing", name: "ghost" }), { results: [[]] }, "without onNoRows");
  // the parent exists: one row
  const created = await app.procedures.add_contact(db, caller, { client: client.id, name: "ann" });
  equal(created.results[0].length, 1, "one contact written");
  equal(await rows(`SELECT name, client_id FROM contacts WHERE id = '${created.results[0][0].id}'`), [{ name: "ann", client_id: client.id }], "the written contact");

  // several steps: the checked one writes no row, so the audit row written before it rolls back too
  equal(await code(() => app.procedures.add_logged(db, caller, { client: "missing", name: "logged" })), "CONFLICT:row", "the second step writes nothing");
  equal([await count("audit"), await count("contacts")], [0, 1], "the first step rolled back");
  equal(await code(() => app.procedures.add_logged(db, caller, { client: client.id, name: "logged" })), "ok", "both steps write");
  equal([await count("audit"), await count("contacts")], [1, 2], "both steps committed");

  // at least one row, not exactly one: a set UPDATE over two rows passes, over none is CONFLICT
  equal(await code(() => app.procedures.rename_all(db, caller, { client: client.id, name: "same" })), "ok", "a set update over two rows");
  equal(await rows("SELECT name FROM contacts ORDER BY name"), [{ name: "same" }, { name: "same" }], "both rows renamed");
  equal(await code(() => app.procedures.rename_all(db, caller, { client: "missing", name: "none" })), "CONFLICT:row", "a set update over no row");
}
