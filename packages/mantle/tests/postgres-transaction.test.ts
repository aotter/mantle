import { expect, test } from "bun:test";
import { SQL } from "bun";
import { Database } from "bun:sqlite";
import postgres from "postgres";
import ts from "typescript";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOrThrow, loadFixtureSources, loadGenerated, writeGenerated } from "./apps/link.js";
import { verifyApplicationTransaction } from "./postgres-transaction-scenarios.js";
import { user } from "./apps/fixtures.js";

const files = async (target: "bun-postgres" | "cloudflare-postgres" | "cloudflare-d1" | "bun-sqlite") =>
  generateOrThrow(target, await loadFixtureSources("app-transaction.yaml"));

test("an application types its own SQL and generated Procedures in one Store transaction from public imports only", async () => {
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/app-transaction-"));
  try {
    const roots: string[] = [];
    for (const target of ["bun-postgres", "cloudflare-postgres"] as const) {
      const destination = resolve(dir, target);
      await writeGenerated(destination, await files(target), false);
      const consumer = resolve(destination, "consumer.ts");
      await writeFile(
        consumer,
        `import type { Caller, Postgres } from "@aotter/mantle/contracts";
import { procedures, store } from "./generated.js";
export async function book(db: Postgres, caller: Caller, key: number, item: string) {
  return store(db, caller).transaction(
    async (tx, sql) => {
      const handle: Postgres = sql;
      await handle.unsafe("SELECT pg_advisory_xact_lock($1)", [key]);
      await sql.unsafe("INSERT INTO app_ledger (key, note) VALUES ($1, $2)", [key, item]);
      await procedures.book(sql, caller, { item });
      const output: { results: readonly unknown[] } = await tx.procedures.book({ item });
      return output;
    },
    { isolation: "read committed" },
  );
}
export function refused(db: Postgres, caller: Caller) {
  // @ts-expect-error only PostgreSQL's four isolation levels
  store(db, caller).transaction(async () => {}, { isolation: "snapshot" });
  // @ts-expect-error the handle is the second argument, not a Store
  store(db, caller).transaction(async (tx, sql) => sql.collection("bookings"));
}
`,
      );
      roots.push(consumer);
    }
    const sqlite = resolve(dir, "bun-sqlite");
    await writeGenerated(sqlite, await files("bun-sqlite"), false);
    await writeFile(
      resolve(sqlite, "consumer.ts"),
      `import type { Caller } from "@aotter/mantle/contracts";
import type { Handle } from "@aotter/mantle/driver/bun-sqlite";
import { procedures, store } from "./generated.js";
export function book(db: Handle, caller: Caller) {
  return store(db, caller).transaction(async (tx, raw) => {
    const handle: Handle = raw;
    handle.query("INSERT INTO app_ledger (key, note) VALUES (?, ?)").run(1, "booked");
    await procedures.book(raw, caller, { item: "seat" });
    return tx.procedures.book({ item: "seat" });
  });
}
`,
    );
    roots.push(resolve(sqlite, "consumer.ts"));
    const d1 = resolve(dir, "cloudflare-d1");
    await writeGenerated(d1, await files("cloudflare-d1"), false);
    await writeFile(
      resolve(d1, "consumer.ts"),
      `import type { Caller } from "@aotter/mantle/contracts";
import { store } from "./generated.js";
export function check(db: Parameters<typeof store>[0], caller: Caller) {
  // @ts-expect-error D1 has no interactive transaction
  store(db, caller).transaction;
}
`,
    );
    roots.push(resolve(d1, "consumer.ts"));
    const program = ts.createProgram(roots, {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      types: ["node", "bun-types"],
      typeRoots: [resolve(import.meta.dir, "../node_modules/@types"), resolve(import.meta.dir, "../node_modules")],
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map(d => `${d.file?.fileName} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`)
        .join("\n"),
    ).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("bun-sqlite: a caught multi-step Procedure failure still rolls back the transaction it joined", async () => {
  const generated = await files("bun-sqlite");
  const app = await loadGenerated(generated["generated.ts"]!);
  const db = new Database(":memory:");
  try {
    db.exec(generated["schema.sql"]!);
    db.exec("CREATE TABLE app_ledger (key INTEGER PRIMARY KEY, note TEXT NOT NULL)");
    const alice = user("tx-alice");
    await app.procedures.book(db, alice, { item: "seat" });
    const seat: any = db.query("SELECT id, version FROM bookings WHERE item = 'seat'").get();
    const items = () => db.query("SELECT item FROM bookings UNION ALL SELECT note FROM app_ledger ORDER BY 1").all();
    const before = items();
    let caught: any;
    await expect(
      app.store(db, alice).transaction(async (tx: any, raw: Database) => {
        raw.query("INSERT INTO app_ledger (key, note) VALUES (1, 'raw')").run();
        try {
          await tx.procedures.rebook({ id: seat.id, item: "stale", version: seat.version + 1 });
        } catch (error) {
          caught = error;
        }
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(caught?.code).toBe("CONFLICT");
    expect(items()).toEqual(before);
    // The handle is the transaction's only while it runs: afterwards none of it reaches the Database.
    let leaked!: Database;
    await app.store(db, alice).transaction(async (_tx: any, raw: Database) => void (leaked = raw));
    for (const use of [
      () => leaked.query("INSERT INTO app_ledger (key, note) VALUES (2, 'late')"),
      () => leaked.exec("INSERT INTO app_ledger (key, note) VALUES (2, 'late')"),
      () => leaked.transaction(() => {}),
    ])
      expect(use).toThrow("Transaction has ended.");
    expect(items()).toEqual(before);
  } finally {
    db.close();
  }
});

for (const target of ["bun-postgres", "cloudflare-postgres"] as const) {
  const url = target === "bun-postgres" ? process.env.MANTLE_NEXT_BUN_PG_URL : process.env.MANTLE_NEXT_WORKER_PG_URL;
  (url ? test : test.skip)(
    `${target}: application SQL, an advisory lock and generated Procedures commit or roll back as one transaction`,
    async () => {
      const generated = await files(target);
      const app = await loadGenerated(generated["generated.ts"]!);
      const schema = "app_transaction_" + crypto.randomUUID().replaceAll("-", "");
      const open = (): any =>
        target === "bun-postgres" ? new SQL({ url: url!, max: 1 }) : postgres(url!, { max: 1, onnotice: () => {} });
      const end = (db: any) => (target === "bun-postgres" ? db.close() : db.end({ timeout: 1 }));
      const admin = open();
      try {
        await admin.unsafe(`CREATE SCHEMA ${schema}`);
        await admin.unsafe(`SET search_path TO ${schema}`);
        await admin.unsafe(generated["schema.sql"]!);
        const result = await verifyApplicationTransaction({
          app,
          connect: async () => {
            const db = open();
            await db.unsafe(`SET search_path TO ${schema}`);
            return db;
          },
          end,
        });
        expect(result.checks).toBe(12);
      } finally {
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await end(admin);
      }
    },
    60_000,
  );
}
