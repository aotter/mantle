/** `requires.auth` evaluated against the Caller only (ADR-0032 decision 8); the grammar is unchanged. */
import { makeDiagnostic, type Diagnostic } from "../../spec/kernel/index.js";
import type { AuthPredicate, AuthorizationRequirements } from "../../spec/domain/index.js";
import type { Caller } from "../caller.js";

export function evaluatePredicate(pred: AuthPredicate, caller: Caller): boolean {
  // the system caller satisfies no predicate; an anonymous caller has no user, credential, role or scope
  if (caller.kind !== "user") return false;
  if (pred === "ctx.user" || pred === "ctx.auth") return true;
  if ("ctx.auth.scope" in pred) return caller.scopes.includes(pred["ctx.auth.scope"]);
  return caller.role !== null && pred["ctx.staff"].includes(caller.role);
}

export function describePredicate(pred: AuthPredicate): string {
  if (pred === "ctx.user") return "caller is signed in (ctx.user)";
  if (pred === "ctx.auth") return "caller presents a verified credential (ctx.auth)";
  if ("ctx.auth.scope" in pred) return `caller credential includes scope '${pred["ctx.auth.scope"]}'`;
  return `caller is staff with role in [${pred["ctx.staff"].join(", ")}]`;
}

/** `null` when every predicate holds (or none is declared), else a 401/403 Diagnostic naming the first that fails. */
export function evaluateAuthAll(requires: AuthorizationRequirements | undefined, caller: Caller, path: string): Diagnostic | null {
  const all = requires?.auth?.all ?? [];
  for (const [i, pred] of all.entries()) {
    if (evaluatePredicate(pred, caller)) continue;
    return makeDiagnostic({
      code: caller.kind === "user" ? "AUTH_DENIED" : "UNAUTHENTICATED",
      phase: "runtime",
      severity: "error",
      path: `${path}#/requires/auth/all/${i}`,
      expected: describePredicate(pred),
      message: `Authorization predicate not satisfied: ${describePredicate(pred)}.`,
    });
  }
  return null;
}
