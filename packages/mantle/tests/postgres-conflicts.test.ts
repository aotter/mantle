import { expect, test } from "bun:test";
import { SQL } from "bun";
import postgres from "postgres";
import { generateOrThrow, loadFixtureSources, loadGenerated } from "./apps/link.js";
import { user } from "./apps/fixtures.js";
import { postgresOutcome } from "../src/kernel/driver/postgres.js";

test("PostgreSQL rollback classification requires server evidence and preserves uncertain COMMIT outcomes", () => {
  for (const key of ["code", "errno"] as const) for (const state of ["40001", "40P01"]) {
    const unproven = Object.assign(new Error("missing server evidence"), { [key]: state });
    expect(postgresOutcome(unproven, "test")).toMatchObject({code:"OUTCOME_UNKNOWN",cause:unproven});
    const server = Object.assign(new Error("server refusal"), { [key]: state, severity:"ERROR" });
    expect(postgresOutcome(server, "test")).toMatchObject({code:"CONFLICT",path:"test",fields:{kind:"serialization"},cause:server});
  }
  for (const state of ["08006", "57P01", "ERR_POSTGRES_CONNECTION_CLOSED"]) {
    const error = Object.assign(new Error("lost connection"), {code:state,severity:"ERROR"});
    expect(postgresOutcome(error, "test")).toMatchObject({code:"OUTCOME_UNKNOWN",cause:error});
  }
});

for (const target of ["bun-postgres", "cloudflare-postgres"] as const) {
  const url = target === "bun-postgres" ? process.env.MANTLE_NEXT_BUN_PG_URL : process.env.MANTLE_NEXT_WORKER_PG_URL;
  (url ? test : test.skip)(`${target}: a competing native Store batch returns serialization CONFLICT and rolls back every step`, async () => {
    const files = await generateOrThrow(target, await loadFixtureSources("postgres-conflicts.yaml"));
    const app = await loadGenerated(files["generated.ts"]!);
    const connect = () => target === "bun-postgres" ? new SQL(url!, {max:1}) : postgres(url!, {max:1,onnotice:()=>{}});
    const db: any = connect(), rival: any = connect();
    const schema = "serialization_" + crypto.randomUUID().replaceAll("-", "");
    try {
      await db.unsafe(`CREATE SCHEMA ${schema}`);
      for (const handle of [db, rival]) await handle.unsafe(`SET search_path TO ${schema}`);
      await db.unsafe(files["schema.sql"]!);
      const caller = user("editor"), original = app.store(db, caller), other = app.store(rival, caller);
      const first = await original.collection("notes").insert({title:"first"});
      const second = await original.collection("notes").insert({title:"second"});
      let attempts = 0;
      // Pin a real SERIALIZABLE snapshot before the other connection commits. The batch's first write succeeds,
      // then its second write gets native SQLSTATE40001; the driver must roll both back and never retry.
      const racing = { unsafe: db.unsafe.bind(db), begin: (options: string, fn: (tx: unknown) => Promise<unknown>) => db.begin(options, async (tx: any) => {
        attempts++;
        await tx.unsafe("SELECT id FROM notes WHERE id = $1", [second.id]);
        await other.collection("notes").update(second.id, {title:"other writer"}, {lock:second.version});
        return fn(tx);
      }) };
      const store = app.store(racing, caller), notes = store.collection("notes");
      let caught: any;
      try {
        await store.batch([
          notes.update(first.id, {title:"must roll back"}, {lock:first.version}),
          notes.update(second.id, {title:"loser"}, {lock:second.version}),
        ]);
      } catch (error) { caught = error; }
      expect(caught).toMatchObject({code:"CONFLICT",fields:{kind:"serialization"}});
      expect(caught.cause.errno ?? caught.cause.code).toBe("40001");
      expect(attempts).toBe(1);
      expect(await original.collection("notes").findById(first.id)).toMatchObject({title:"first",version:1});
      expect(await original.collection("notes").findById(second.id)).toMatchObject({title:"other writer",version:2});
    } finally {
      await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (target === "bun-postgres") { await db.close(); await rival.close(); }
      else { await db.end(); await rival.end(); }
    }
  }, 30000);
}
