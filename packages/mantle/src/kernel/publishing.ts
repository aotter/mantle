/** A generated publishing transition, staff or system only; `write` claims translation state, released on CONFLICT. */
import { deny, type Caller, type Output, type Row } from "./contracts.js";
import { bound, type Bound, type Step, type Values } from "./binds.js";

export async function transition<DB>(db: DB, caller: Caller, input: Readonly<Record<string, unknown>>, path: string, staff: readonly string[], steps: readonly Step[], failure: string, d: Values, execute: (db: DB, steps: readonly Bound[], path: string) => Promise<Row[][]>, write?: () => () => void): Promise<Output> {
  deny(caller, caller.kind === "system" || caller.kind === "user" && staff.includes(caller.role ?? ""), path);
  const release = write?.();
  return { results: await execute(db, bound(d, steps, caller, input), path).catch(error => {
    if (release && error?.code === "CONFLICT") release();
    if (error?.code === "CONFLICT" && error.message === "Expected one affected row.") error.message = failure;
    throw error;
  }) };
}
