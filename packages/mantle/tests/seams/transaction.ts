/** Required application seam `transaction-handle` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import type { Caller } from "@aotter/mantle/contracts";
import { procedures, store } from "./generated/generated.js";

type Db = Parameters<typeof store>[0];

export function inOneTransaction(db: Db, caller: Caller, key: number, title: string) {
  return store(db, caller).transaction(
    async (tx, sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock($1)", [key]);
      await procedures["add-note"](sql, caller, { title, body: null, tags: null });
      return tx.procedures["add-note"]({ title: `${title} (copy)`, body: null, tags: ["copy"] });
    },
    { isolation: "read committed" },
  );
}
