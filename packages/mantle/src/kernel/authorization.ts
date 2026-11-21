import { ContractError, type Authorize, type Target, type Caller } from "./contracts.js";

/** Rejections deny (a list hides the target, a 429 included); synchronous application failures remain internal errors. */
export async function authorized(authorize: Authorize, target: Target, caller: Caller): Promise<boolean> {
  return (await decide(authorize, target, caller)) === true;
}
/**
 * A rejection with an `AUTH_DENIED` ContractError keeps its message (e.g. the role that may call the target), and one
 * with status 429 keeps its code, message, status and fields (`retryAfter`). Any other rejection reveals nothing.
 */
export async function authorizeTarget(authorize: Authorize, target: Target, caller: Caller): Promise<void> {
  const decision = await decide(authorize, target, caller);
  if (decision === true) return;
  if (decision instanceof ContractError && (decision.code === "AUTH_DENIED" || decision.status === 429)) throw decision;
  throw new ContractError("AUTH_DENIED", "Target is not authorized.", target.kind + "/" + target.name);
}
async function decide(authorize: Authorize, target: Target, caller: Caller): Promise<unknown> {
  let result: boolean | Promise<boolean>;
  try {
    result = authorize(target, caller);
  } catch (cause) {
    throw new Error("Authorization failed.", { cause });
  }
  return Promise.resolve(result).catch((error: unknown) => error);
}
