// @ts-nocheck test code over loosely typed results
/** Native per-operation acquisition: TCP proxy counts messages without a request scheduler or write pipeline. */
import { expect, it } from "vitest";
import { createMantleAuth } from "../../src/auth/index.js";
import { pgDatabaseDriver, pgPool, postgresStorage } from "../../src/postgres/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { boot, caller, isConflict, opIndexOf, program, runProcedure, runView, site, useCompileSide } from "../../src/testing/harness.js";
import { PG_URL, freshSchema } from "./engine.js";
import { roundTripProxy } from "./proxy.js";

const ONE_WAY_MS = Number(process.env.MANTLE_PG_ONE_WAY_MS ?? 0);

async function measure() {
  const proxy = await roundTripProxy(new URL(PG_URL!), ONE_WAY_MS);
  const db = await freshSchema({ url: proxy.url });
  useCompileSide(pgCompile);
  try {
    const s = site(await boot({ storage: postgresStorage({ connect: db.connect }), driver: pgDatabaseDriver(db.connect) }));
    const codes = new Map<string, string>();
    const auth = createMantleAuth({
      database: pgPool(db.connect), driver: pgDatabaseDriver(db.connect), baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"],
      methods: [{ kind: "email-otp", sender: { send: async ({ to, text }) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }],
      bootstrapOwner: { match: "email", value: "owner@x.test" },
    });
    const post = (path: string, body: unknown) =>
      auth.handler(new Request(`http://localhost/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "x-real-ip": "1.1.1.1" }, body: JSON.stringify(body) }));
    await post("/email-otp/send-verification-otp", { email: "owner@x.test", type: "sign-in" });
    await new Promise((r) => setTimeout(r, 50 + 4 * ONE_WAY_MS));
    const signedIn = await post("/sign-in/email-otp", { email: "owner@x.test", otp: codes.get("owner@x.test") });
    const owner = new Request("http://localhost/admin/api/staff", { headers: { cookie: signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } });
    const read = await program("view", "SELECT id, stock FROM items WHERE cat = 'x' ORDER BY id");
    const write = await program("procedure", [
      "UPDATE items SET stock = stock + 1 WHERE id = 'a'",
      "UPDATE items SET stock = stock + 1 WHERE id = 'b'",
      "UPDATE items SET stock = stock - 1 WHERE id = 'd'",
      "INSERT INTO settings (key, value) VALUES ('rt', 'x') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ].join("; "));
    const missing = await program("procedure", "UPDATE items SET stock = stock + 1 WHERE id = 'a'; UPDATE items SET stock = 1 WHERE id = 'nope'");
    // a request's connections are those opened while it ran; its round trips are theirs (the proxy leaves out each handshake)
    const request = async (f: () => Promise<unknown>) => {
      const from = proxy.trips.length;
      const before = proxy.trips.slice();
      const t0 = performance.now();
      const result = await f().catch((e) => e);
      const ms = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 2 * ONE_WAY_MS + 20));
      const opened = proxy.trips.slice(from);
      const reused = proxy.trips.slice(0, from).reduce((n, t, i) => n + t - before[i]!, 0);
      return { result, ms, connections: opened.length, trips: reused + opened.reduce((n, t) => n + t, 0) };
    };
    const out = {
      getSession: await request(() => auth.getSession(owner)),
      listUsers: await request(() => auth.listUsers(owner)),
      "View read": await request(() => runView(s, read, caller())),
      "4-statement write": await request(() => runProcedure(s, write, caller())),
      "getSession + View + write": await request(async () => { await auth.getSession(owner); await runView(s, read, caller()); await runProcedure(s, write, caller()); }),
      "failed expect": await request(() => runProcedure(s, missing, caller())),
    };
    const [after] = await pgDatabaseDriver(db.connect).batch([{ sql: "SELECT stock FROM items WHERE id = 'a'" }]);
    return { out, stockA: after.rows[0].stock };
  } finally { useCompileSide(undefined); await db.drop(); await proxy.close(); }
}

it.skipIf(!PG_URL)("native reads acquire per operation, writes run sequentially and failed expect rolls back", async () => {
  const { out, stockA } = await measure();
  for (const [what, m] of Object.entries(out)) if (what !== "failed expect") expect(m.result, what).not.toBeInstanceOf(Error);
  expect(out["View read"]).toMatchObject({ connections: 1, trips: 1 });
  expect(out["4-statement write"]).toMatchObject({ connections: 1, trips: 6 });
  expect(out.listUsers.connections).toBeGreaterThan(1);
  expect(isConflict(out["failed expect"].result)).toBe(true);
  expect(opIndexOf(out["failed expect"].result)).toBe(1);
  expect(stockA).toBe(7);
  console.log(Object.fromEntries(Object.entries(out).map(([name, {result, ...counts}]) => [name, counts])));
}, 240_000);
