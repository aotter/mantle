import { ContractError, type Authorize, type Target, type Caller } from "./contracts.js";

/** Rejections deny; synchronous application failures remain internal errors. */
export async function authorized(authorize: Authorize, target: Target, caller: Caller): Promise<boolean> {
  let result: boolean | Promise<boolean>;
  try { result = authorize(target, caller); } catch (cause) { throw new Error("Authorization failed.", { cause }); }
  return await Promise.resolve(result).catch(() => false) === true;
}
export async function authorizeTarget(authorize: Authorize, target: Target, caller: Caller): Promise<void> {
  if (!await authorized(authorize, target, caller)) throw new ContractError("AUTH_DENIED", "Target is not authorized.", target.kind + "/" + target.name);
}
