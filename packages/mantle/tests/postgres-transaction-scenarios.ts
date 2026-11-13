/**
 * Application SQL and generated Procedures in one PostgreSQL transaction (#2015): `store(db, caller).transaction((tx, db)
 * => …)` on a real driver. Runs under `bun test` (Bun.SQL and postgres.js) and inside workerd through local Hyperdrive
 * (verify-native), so it uses node:assert only. Needs the `app-transaction.yaml` fixture applied to an empty schema.
 */
import assert from "node:assert/strict";
import { user } from "./apps/fixtures.js";

interface Db {
  unsafe(text: string, values: unknown[]): PromiseLike<any>;
  begin(options: string, fn: (tx: any) => Promise<any>): PromiseLike<any>;
}
export interface ApplicationTransactionEnv {
  /** The generated app (`import * as app`) for app-transaction.yaml. */
  app: { store: any; procedures: any };
  /** A new single-connection client whose search_path names the fixture's schema. */
  connect(): Promise<Db>;
  end(db: Db): Promise<void>;
}

export async function verifyApplicationTransaction(env: ApplicationTransactionEnv): Promise<{ checks: number }> {
  let checks = 0;
  const ok = () => void checks++;
  const alice = user("tx-alice"),
    bob = user("tx-bob"),
    key = 2015;
  const db = await env.connect(),
    other = await env.connect();
  let begins = 0;
  const counted: Db = {
    unsafe: db.unsafe.bind(db),
    begin: (options, fn) => {
      begins++;
      return db.begin(options, fn);
    },
  };
  const { procedures } = env.app,
    store = (caller = alice, handle: Db = counted) => env.app.store(handle, caller);
  // `other` is a second connection: it sees only what has committed.
  const count = async (text: string, handle: Db = other) => Number((await handle.unsafe(text, []))[0].n);
  const ledger = () => count("SELECT count(*) AS n FROM app_ledger WHERE key < 100");
  const bookings = () => count("SELECT count(*) AS n FROM bookings");
  const lockFree = async () => {
    const [{ got }] = await other.unsafe("SELECT pg_try_advisory_lock($1) AS got", [key]);
    if (got) await other.unsafe("SELECT pg_advisory_unlock($1)", [key]);
    return got as boolean;
  };
  const sqlstate = (error: any) => (typeof error?.errno === "string" ? error.errno : error?.code);
  try {
    await db.unsafe("CREATE TABLE app_ledger (key int8 PRIMARY KEY, note text NOT NULL)", []);

    // The issue's example: an advisory lock, a write to an application-owned table and generated multi-step
    // Procedures, one COMMIT at the chosen isolation. Inside, the Procedures' rows are visible on the transaction's
    // handle and invisible to another connection, and no second BEGIN ran: they joined.
    const booked = await store().transaction(
      async (tx: any, sql: Db) => {
        await sql.unsafe("SELECT pg_advisory_xact_lock($1)", [key]);
        await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [1, "booked"]);
        const output = await tx.procedures.book({ item: "seat" });
        await procedures.book(sql, alice, { item: "seat-2" });
        assert.equal(await count("SELECT count(*) AS n FROM bookings", sql), 4);
        assert.equal(await bookings(), 0);
        assert.equal(await ledger(), 0);
        assert.equal(await lockFree(), false);
        assert.equal(begins, 1);
        const [{ transaction_isolation }] = await sql.unsafe("SHOW transaction_isolation", []);
        assert.equal(transaction_isolation, "read committed");
        return output;
      },
      { isolation: "read committed" },
    );
    assert.equal(booked.results.length, 2);
    assert.equal(await ledger(), 1);
    assert.equal(await bookings(), 4);
    assert.equal(await lockFree(), true);
    ok();

    // A throw rolls back the lock, the application's row and the Procedure's rows together.
    const abort = new Error("abort");
    await assert.rejects(
      store().transaction(async (tx: any, sql: Db) => {
        await sql.unsafe("SELECT pg_advisory_xact_lock($1)", [key]);
        await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [2, "lost"]);
        await tx.procedures.book({ item: "lost" });
        throw abort;
      }),
      (error: unknown) => error === abort,
    );
    assert.equal(await ledger(), 1);
    assert.equal(await bookings(), 4);
    assert.equal(await lockFree(), true);
    ok();

    // The isolation option is what the transaction runs at; serializable by default.
    for (const isolation of [undefined, "serializable", "repeatable read", "read committed", "read uncommitted"]) {
      const shown = await store().transaction(
        async (_tx: any, sql: Db) => (await sql.unsafe("SHOW transaction_isolation", []))[0].transaction_isolation,
        isolation && { isolation },
      );
      assert.equal(shown, isolation ?? "serializable");
    }
    ok();

    const [seat] = await other.unsafe("SELECT id, version FROM bookings WHERE item = 'seat'", []);
    const stale = { id: seat.id, item: "stale", version: Number(seat.version) + 1 };
    // A multi-step Procedure whose second step fails after its first wrote: catching the error does not commit
    // that first step, nor anything else in the transaction.
    let caught: any;
    await assert.rejects(
      store().transaction(async (tx: any, sql: Db) => {
        await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [3, "caught procedure"]);
        try {
          await tx.procedures.rebook(stale);
        } catch (error) {
          caught = error;
        }
        return "must not commit";
      }),
      (error: unknown) => error === caught && caught.code === "CONFLICT",
    );
    assert.equal(await ledger(), 1);
    assert.equal(await bookings(), 4);
    ok();
    // So does a failed statement of the application's own, caught: PostgreSQL aborted the transaction, and the
    // rejection is that known rollback, not OUTCOME_UNKNOWN.
    await assert.rejects(
      store().transaction(async (_tx: any, sql: Db) => {
        await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [4, "before duplicate"]);
        try {
          await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [1, "duplicate"]);
        } catch {}
      }),
      (error: any) => error?.code !== "OUTCOME_UNKNOWN",
    );
    assert.equal(await ledger(), 1);
    ok();
    // A single-statement write that fails its row check changed nothing: catching it leaves the transaction usable.
    await store().transaction(async (tx: any, sql: Db) => {
      await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [5, "single write caught"]);
      await assert.rejects(
        tx.collection("bookings").update(stale.id, { item: "stale" }, { lock: stale.version }),
        (error: any) => error?.code === "CONFLICT",
      );
    });
    assert.equal(await ledger(), 2);
    ok();
    // Opening a transaction inside one is refused before any SQL; no savepoint is taken.
    await store().transaction(async (_tx: any, sql: Db) => {
      await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [6, "after nested refusal"]);
      await assert.rejects(
        store(alice, sql).transaction(async () => {}),
        /Nested transactions/,
      );
    });
    assert.equal(await ledger(), 3);
    ok();

    // Row rules still bind the generated code inside; the raw handle is outside them.
    await assert.rejects(
      store(bob).transaction(async (tx: any, sql: Db) => {
        assert.equal(await tx.collection("bookings").count(), 0);
        assert.equal(await count("SELECT count(*) AS n FROM bookings", sql), 4);
        await procedures.rebook(sql, bob, { ...stale, version: Number(seat.version), item: "bob" });
      }),
      (error: any) => error?.code === "CONFLICT",
    );
    assert.equal((await other.unsafe("SELECT item FROM bookings WHERE id = $1", [seat.id]))[0].item, "seat");
    ok();

    // Two transactions on two connections contend on the advisory lock: the second waits for the first's COMMIT.
    const second = await env.connect();
    try {
      const order: string[] = [];
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve)),
        started = new Promise<void>(resolve => (entered = resolve));
      const first = store(alice, db).transaction(
        async (_tx: any, sql: Db) => {
          await sql.unsafe("SELECT pg_advisory_xact_lock($1)", [key]);
          order.push("first-locked");
          entered();
          await gate;
          await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [7, "first"]);
          order.push("first-done");
        },
        { isolation: "read committed" },
      );
      await started;
      const contender = store(alice, second).transaction(
        async (_tx: any, sql: Db) => {
          await sql.unsafe("SELECT pg_advisory_xact_lock($1)", [key]);
          order.push("second-locked");
          assert.equal(await count("SELECT count(*) AS n FROM app_ledger WHERE key = 7", sql), 1);
        },
        { isolation: "read committed" },
      );
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.deepEqual(order, ["first-locked"]);
      release();
      await Promise.all([first, contender]);
      assert.deepEqual(order, ["first-locked", "first-done", "second-locked"]);
    } finally {
      await env.end(second);
    }
    ok();

    // A concurrent update after the snapshot is a serialization failure: CONFLICT, rolled back, never retried.
    for (const isolation of ["repeatable read", "serializable"]) {
      await db.unsafe(
        "INSERT INTO app_ledger (key, note) VALUES (100, 'v0') ON CONFLICT (key) DO UPDATE SET note = 'v0'",
        [],
      );
      const before = begins;
      await assert.rejects(
        store().transaction(
          async (_tx: any, sql: Db) => {
            await sql.unsafe("SELECT note FROM app_ledger WHERE key = 100", []);
            await other.unsafe("UPDATE app_ledger SET note = 'other' WHERE key = 100", []);
            await sql.unsafe("UPDATE app_ledger SET note = 'mine' WHERE key = 100", []);
          },
          { isolation },
        ),
        (error: any) =>
          error?.code === "CONFLICT" && error.fields?.kind === "serialization" && sqlstate(error.cause) === "40001",
      );
      assert.equal(begins, before + 1);
      assert.equal((await other.unsafe("SELECT note FROM app_ledger WHERE key = 100", []))[0].note, "other");
    }
    ok();

    // The connection drops after the callback resolved, before COMMIT is answered: the outcome is unknown.
    const doomed = await env.connect();
    let pid: unknown;
    const losing: Db = {
      unsafe: doomed.unsafe.bind(doomed),
      begin: (options, fn) =>
        doomed.begin(options, async tx => {
          const result = await fn(tx);
          await other.unsafe("SELECT pg_terminate_backend($1)", [pid]);
          return result;
        }),
    };
    await assert.rejects(
      store(alice, losing).transaction(async (_tx: any, sql: Db) => {
        pid = (await sql.unsafe("SELECT pg_backend_pid() AS pid", []))[0].pid;
        await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [8, "unknown"]);
      }),
      (error: any) => error?.code === "OUTCOME_UNKNOWN",
    );
    await env.end(doomed).catch(() => {});
    ok();
  } finally {
    await env.end(db);
    await env.end(other);
  }
  return { checks };
}
