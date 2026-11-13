/**
 * Application seam `transaction-handle` on bun:sqlite (packages/mantle/tests/application-seams.ts): the application's own
 * SQL and generated Procedures in one transaction. Public imports only, no casts.
 */
import type { Caller } from "@aotter/mantle/contracts";
import { procedures, store } from "./generated/generated.js";

type Db = Parameters<typeof store>[0];

/** Two notes and a line in the application's own `note_log`, committed together. */
export function addNotesLocked(db: Db, caller: Caller, key: number, title: string) {
  return store(db, caller).transaction(async (tx, sql) => {
    sql.query("INSERT INTO note_log (key, title) VALUES (?, ?)").run(key, title);
    await procedures["add-note"](sql, caller, { title, body: null, tags: null });
    return tx.procedures["add-note"]({ title: `${title} (copy)`, body: null, tags: ["copy"] });
  });
}
