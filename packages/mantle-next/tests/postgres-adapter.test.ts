import { expect, test } from "bun:test";
import { SQL } from "bun";
import postgres from "postgres";
import { ContractError, type Postgres } from "../src/kernel/contracts.js";
import { verifyPostgresAdapter } from "../scripts/postgres-adapter.js";

const url = process.env.MANTLE_NEXT_BUN_PG_URL;
for (const driver of ["Bun.SQL", "postgres.js", "non-interactive adapter"] as const) (url ? test : test.skip)(`Postgres adapter conformance: ${driver}`, async () => {
  const result = await verifyPostgresAdapter(async () => {
    const schema = `adapter_${crypto.randomUUID().replaceAll("-", "")}`;
    const native = driver === "Bun.SQL" ? new SQL({ url: url!, max: 1 }) : postgres(url!, { max: 1, onnotice: () => {} });
    const db: Postgres = native;
    await db.unsafe(`CREATE SCHEMA "${schema}"`, []);
    await db.unsafe(`SET search_path TO "${schema}"`, []);
    return {
      db: driver === "non-interactive adapter" ? { unsafe: db.unsafe.bind(db), begin: async () => { throw new ContractError("TRANSACTION_UNSUPPORTED", "This adapter has no interactive transactions; use a transactional PostgreSQL adapter.", "store/transaction", { status: 400 }); } } : db,
      interactive: driver !== "non-interactive adapter",
      close: async () => { try { await db.unsafe(`DROP SCHEMA "${schema}" CASCADE`, []); } finally { if (driver === "Bun.SQL") await (native as SQL).close(); else await (native as ReturnType<typeof postgres>).end(); } },
    };
  });
  expect(result.checks).toBeGreaterThanOrEqual(23);
}, 60_000);
