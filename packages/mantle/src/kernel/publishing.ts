/** A generated publishing transition, admin or system only; `write` claims translation state, released on CONFLICT. */
import { isAdmin, deny, type Caller, type Output, type Row } from "./contracts.js";
import { bound, type Bound, type Step, type Values } from "./binds.js";

export async function transition<DB>(db: DB, caller: Caller, input: Readonly<Record<string, unknown>>, path: string, steps: readonly Step[], failure: string, d: Values, execute: (db: DB, steps: readonly Bound[], path: string) => Promise<Row[][]>, write?: () => () => void): Promise<Output> {
  deny(caller, caller.kind === "system" || isAdmin(caller), path);
  const release = write?.();
  return { results: await execute(db, bound(d, steps, caller, input), path).catch(error => {
    if (release && error?.code === "CONFLICT") release();
    if (error?.code === "CONFLICT" && error.message === "Expected one affected row.") error.message = failure;
    throw error;
  }) };
}
