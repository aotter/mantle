// @ts-nocheck test code over loosely typed results
/**
 * #1379, per request: the connections a request opens and the round trips it takes, counted by a TCP proxy, for Better Auth's
 * getSession and listUsers, a View read, a 4-statement write and an authenticated request (all three). Unscoped, every
 * operation opens a connection; in `requestScoped`, a request opens one. A read is one round trip either way; a write batch is
 * N + 2, or 1 when the client pipelines. MANTLE_PG_ONE_WAY_MS adds latency each way and prints the table with wall times.
 */
import { expect, it } from "vitest";
import { createMantleAuth } from "../../src/auth/index.js";
import { pgDatabaseDriver, pgPool, postgresStorage, requestScoped } from "../../src/postgres/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { boot, caller, isConflict, opIndexOf, program, runProcedure, runView, site, useCompileSide } from "../../src/testing/harness.js";
import { PG_URL, freshSchema } from "./engine.js";
import { roundTripProxy } from "./proxy.js";

const ONE_WAY_MS = Number(process.env.MANTLE_PG_ONE_WAY_MS ?? 0);
const MODES = { "per operation": { scope: false, pipeline: false }, "request-scoped": { scope: true, pipeline: false }, "request-scoped, pipelined": { scope: true, pipeline: true } };

async function measure({ scope, pipeline }: { scope: boolean; pipeline: boolean }) {
  const proxy = await roundTripProxy(new URL(PG_URL!), ONE_WAY_MS);
  const db = await freshSchema({ url: proxy.url, pipeline });
  const session = requestScoped(db.connect);
  useCompileSide(pgCompile);
  try {
    const s = site(await boot({ storage: postgresStorage({ connect: session.connect }), driver: pgDatabaseDriver(session.connect) }));
    const codes = new Map<string, string>();
    const auth = createMantleAuth({
      database: pgPool(session.connect), driver: pgDatabaseDriver(session.connect), baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"],
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
    // a request's connections are those opened while it ran; its round trips are theirs, less each startup handshake
    const request = async (f: () => Promise<unknown>) => {
      const from = proxy.trips.length;
      const before = proxy.trips.slice();
      const t0 = performance.now();
      const result = await (scope ? session.run(f) : f()).catch((e) => e);
      const ms = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 2 * ONE_WAY_MS + 20));
      const opened = proxy.trips.slice(from);
      const reused = proxy.trips.slice(0, from).reduce((n, t, i) => n + t - before[i]!, 0);
      return { result, ms, connections: opened.length, trips: reused + opened.reduce((n, t) => n + t - 1, 0) };
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

it.skipIf(!PG_URL)("a request opens one connection when scoped; a read is one round trip, a write batch N + 2 or 1 pipelined", async () => {
  const runs = {};
  for (const [name, mode] of Object.entries(MODES)) runs[name] = await measure(mode);
  for (const { out } of Object.values(runs)) for (const [what, m] of Object.entries(out)) if (what !== "failed expect") expect(m.result, what).not.toBeInstanceOf(Error);
  const [perOp, scoped, piped] = Object.values(runs).map((r) => r.out);
  expect(perOp["View read"]).toMatchObject({ connections: 1, trips: 1 });
  expect(perOp["4-statement write"]).toMatchObject({ connections: 1, trips: 6 });
  // Better Auth asks its pool for a client per query: each its own connection, unscoped
  expect(perOp.listUsers.connections).toBeGreaterThan(1);
  for (const m of Object.values(scoped).concat(Object.values(piped))) expect(m.connections).toBe(1);
  for (const what of Object.keys(scoped)) expect(scoped[what].trips, what).toBeLessThanOrEqual(perOp[what].trips);
  expect(scoped["View read"].trips).toBe(1);
  expect(scoped["4-statement write"].trips).toBe(6);
  expect(piped["View read"].trips).toBe(1);
  expect(piped["4-statement write"].trips).toBe(1);
  expect(scoped["getSession + View + write"].trips).toBe(scoped.getSession.trips + 1 + 6);
  expect(piped["getSession + View + write"].trips).toBe(piped.getSession.trips + 1 + 1);
  // an expect that fails is checked by PostgreSQL: CONFLICT naming op 1, op 0 rolled back; pipelined, one round trip plus ROLLBACK
  for (const { out, stockA } of Object.values(runs)) {
    expect(isConflict(out["failed expect"].result)).toBe(true);
    expect(opIndexOf(out["failed expect"].result)).toBe(1);
    expect(stockA).toBe(5 + 2);
  }
  expect(piped["failed expect"].trips).toBe(2);
  const table = Object.keys(perOp).map((what) => `| ${what} | ${Object.values(runs).map(({ out }) => `${out[what].connections} / ${out[what].trips}${ONE_WAY_MS ? ` / ${out[what].ms.toFixed(0)} ms` : ""}`).join(" | ")} |`);
  console.log([`one-way ${ONE_WAY_MS} ms: connections / round trips${ONE_WAY_MS ? " / wall" : ""}`, `| request | ${Object.keys(MODES).join(" | ")} |`, ...table].join("\n"));
}, 240_000);
