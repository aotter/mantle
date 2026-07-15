import {
  makeDiagnostic,
  type AuthPredicate,
  type Diagnostic,
  type Phase,
} from "@aotter/mantle-spec";
import type { HandlerContext } from "../model/HandlerContext.js";

/**
 * Pure auth-predicate evaluator. Shared by `InvokeProcedureUseCase`
 * and `ExecuteViewUseCase` so the `requires.auth.all` semantics in the
 * manifest grammar produce identical runtime behavior across atoms.
 *
 * The closed `ctx.user` / `ctx.staff` / `ctx.auth` / `ctx.auth.scope`
 * vocabulary is enforced at parse time; this evaluator trusts the shape
 * and only checks against the live `HandlerContext`.
 *
 * Domain-pure: no IO, no port deps. Lives in `domain/service/` because
 * both the procedure and view use cases need it; placing it in either
 * use case would create a usecase→usecase coupling.
 */

export interface AuthRequires {
  readonly auth?: { readonly all: readonly AuthPredicate[] };
}

/**
 * Evaluate `requires.auth.all` against `ctx`. Returns `null` when
 * authorization passes (or no `requires.auth.all` is declared), or an
 * structured 401/403 Diagnostic naming the first failing predicate.
 */
export function evaluateAuthAll(
  requires: AuthRequires | undefined,
  ctx: HandlerContext,
  path: string,
  phase: Phase,
): Diagnostic | null {
  const all = requires?.auth?.all;
  if (!all || all.length === 0) return null;
  for (let i = 0; i < all.length; i++) {
    const pred = all[i]!;
    if (!evaluatePredicate(pred, ctx)) {
      const authenticated = ctx.auth !== undefined || ctx.user !== null || ctx.staff !== null;
      return makeDiagnostic({
        code: authenticated ? "AUTH_DENIED" : "UNAUTHENTICATED",
        phase,
        severity: "error",
        path: `${path}#/requires/auth/all/${i}`,
        expected: describePredicate(pred),
        message: `Authorization predicate not satisfied: ${describePredicate(pred)}.`,
      });
    }
  }
  return null;
}

export function evaluatePredicate(pred: AuthPredicate, ctx: HandlerContext): boolean {
  if (pred === "ctx.user") return ctx.user !== null;
  if (pred === "ctx.auth") return ctx.auth !== undefined;
  if (typeof pred === "object" && pred !== null && "ctx.auth.scope" in pred) {
    return ctx.auth?.scopes.includes(pred["ctx.auth.scope"]) ?? false;
  }
  if (typeof pred === "object" && pred !== null && "ctx.staff" in pred) {
    if (!ctx.staff) return false;
    return pred["ctx.staff"].includes(ctx.staff.role);
  }
  return false;
}

export function describePredicate(pred: AuthPredicate): string {
  if (pred === "ctx.user") return "caller is signed in (ctx.user)";
  if (pred === "ctx.auth") return "caller presents a verified credential (ctx.auth)";
  if (typeof pred === "object" && pred !== null && "ctx.auth.scope" in pred) {
    return `caller credential includes scope '${pred["ctx.auth.scope"]}'`;
  }
  if (typeof pred === "object" && pred !== null && "ctx.staff" in pred) {
    return `caller is staff with role in [${pred["ctx.staff"].join(", ")}]`;
  }
  // Exhaustive: if AuthPredicate gains a variant the parser admits but
  // this function doesn't yet recognise, fail loud rather than throw
  // on a downstream key access.
  const _exhaustive: never = pred;
  throw new Error(`describePredicate: unrecognised AuthPredicate ${JSON.stringify(_exhaustive)}`);
}
