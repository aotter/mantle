import { AsyncLocalStorage } from "node:async_hooks";
import { ContractError } from "../contracts.js";

export const context = new AsyncLocalStorage<{ outer?: object }>();
export function guard(db: object): void {
  if (context.getStore()?.outer === db) throw new ContractError("INPUT_VALIDATION_FAILED", "Inside store.transaction use tx, not the outer store or handle.", "store/transaction");
}
