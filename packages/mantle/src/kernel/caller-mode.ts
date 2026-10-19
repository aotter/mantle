import { ContractError } from "./contract-error.js";
import type { Caller } from "./contracts.js";
import { isHostCaller } from "./caller-identity.js";

export function modeOf(caller: Caller): "caller" | "trusted" {
  const kind = caller.kind;
  if (kind === 'system') return 'trusted';
  if (kind === 'user' || kind === 'anonymous' || kind === 'host' && isHostCaller(caller)) return 'caller';
  throw new ContractError('AUTH_DENIED', 'Unknown caller');
}

/** Only branded host identities may carry freshness authority. */
export function checkFresh(caller: Caller, readOnly: boolean, target?: string): void {
  if (!readOnly && isHostCaller(caller) && "authenticatedAs" in caller && caller.authenticatedAs === "snapshot") throw new ContractError("STALE_CALLER", "Snapshot callers cannot write.", target, { status: 403 });
}
