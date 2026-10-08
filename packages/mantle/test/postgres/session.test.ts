// @ts-nocheck fake clients
/** `requestScoped` (#1379): one client per request, never shared inside another operation's transaction. No database needed. */
import { expect, it } from "vitest";
import { requestScoped } from "../../src/postgres/index.js";

function fakes() {
  const opened: { id: number; ended: boolean; sent: string[] }[] = [];
  const connect = async () => {
    const c = { id: opened.length, ended: false, sent: [] as string[] };
    opened.push(c);
    return {
      query: async (q) => {
        const text = typeof q === "string" ? q : q.text;
        c.sent.push(text);
        if (text === "drop") throw new Error("socket closed");
        if (text === "bad") throw Object.assign(new Error("syntax"), { code: "42601" });
        return { rows: [], rowCount: 0, fields: [] };
      },
      end: async () => void (c.ended = true),
    };
  };
  return { opened, connect };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

it("outside a request every operation opens its own client; inside one they share one, ended when the request ends", async () => {
  const { opened, connect } = fakes();
  const pg = requestScoped(connect);
  for (const _ of [1, 2]) { const c = await pg.connect(); await c.query("SELECT 1"); await c.end(); }
  expect(opened.length).toBe(2);
  await pg.run(async () => {
    for (const _ of [1, 2, 3]) { const c = await pg.connect(); await c.query("SELECT 1"); await c.end(); }
    // an operation that fails with the server's answer leaves the session usable
    const c = await pg.connect();
    await expect(c.query("bad")).rejects.toThrow();
    await c.end();
    expect(opened[2]!.ended).toBe(false);
  });
  await tick();
  expect(opened.length).toBe(3);
  expect(opened[2]).toMatchObject({ ended: true, sent: ["SELECT 1", "SELECT 1", "SELECT 1", "bad"] });
});

it("an operation that arrives while the shared client is held gets its own, so nothing runs inside another's transaction", async () => {
  const { opened, connect } = fakes();
  const pg = requestScoped(connect);
  await pg.run(async () => {
    const tx = await pg.connect();
    await tx.query("BEGIN");
    const other = await pg.connect();
    await other.query("SELECT 1");
    await other.end();
    await tx.query("COMMIT");
    await tx.end();
    const next = await pg.connect();
    await next.query("SELECT 2");
    await next.end();
  });
  await tick();
  expect(opened.map((c) => c.sent)).toEqual([["BEGIN", "COMMIT", "SELECT 2"], ["SELECT 1"]]);
  expect(opened.every((c) => c.ended)).toBe(true);
});

it("a client left in a transaction or with a broken socket is closed, and the next operation opens another", async () => {
  const { opened, connect } = fakes();
  const pg = requestScoped(connect);
  await pg.run(async () => {
    const a = await pg.connect();
    await a.query("BEGIN");
    await a.end();
    const b = await pg.connect();
    await expect(b.query("drop")).rejects.toThrow();
    await b.end();
    const c = await pg.connect();
    await c.query("SELECT 1");
    await c.end();
    expect(opened.map((x) => x.ended)).toEqual([true, true, false]);
  });
  expect(opened.length).toBe(3);
});

it("work still holding the client when the request ends releases it then; later work in its context opens its own", async () => {
  const { opened, connect } = fakes();
  const pg = requestScoped(connect);
  let late: Promise<void> | undefined;
  let release!: () => void;
  await pg.run(async () => {
    const held = await pg.connect();
    late = (async () => {
      await new Promise<void>((r) => (release = r));
      await held.end();
      const after = await pg.connect();
      await after.query("SELECT 1");
      await after.end();
    })();
  });
  await tick();
  expect(opened[0]!.ended).toBe(false);
  release();
  await late;
  await tick();
  expect(opened.map((c) => c.ended)).toEqual([true, true]);
});

it("a client the driver reports inside a transaction is closed even when its SQL looked finished", async () => {
  const { opened, connect } = fakes();
  const pg = requestScoped(async () => Object.assign(await connect(), { getTransactionStatus: () => "T" }));
  await pg.run(async () => {
    for (const _ of [1, 2]) { const c = await pg.connect(); await c.query("SELECT 1"); await c.end(); }
  });
  expect(opened.map((c) => c.ended)).toEqual([true, true]);
});

it("a pipelined batch whose socket drops is OUTCOME_UNKNOWN wherever the first rejection lands; a bind pg may refuse goes one at a time", async () => {
  const { transaction } = await import("../../src/postgres/driver.js");
  const dropped = async () => ({ pipeline: true, query: async () => { throw new Error("Connection terminated"); }, end: async () => undefined });
  await expect(transaction(dropped, [{ text: "UPDATE t SET n = 1" }])).rejects.toMatchObject({ statement: -1, committing: true });
  let inFlight = 0;
  let most = 0;
  const counting = async () => ({
    pipeline: true,
    query: async () => { most = Math.max(most, ++inFlight); await tick(); inFlight--; return { rows: [], rowCount: 1, fields: [] }; },
    end: async () => undefined,
  });
  await transaction(counting, [{ text: "UPDATE t SET n = $1", values: [1] }, { text: "UPDATE t SET n = $1", values: ["x"] }]);
  expect(most).toBe(4);
  most = 0;
  await transaction(counting, [{ text: "UPDATE t SET n = $1", values: [{ toPostgres: () => { throw new Error("no"); } }] }]);
  expect(most).toBe(1);
});
