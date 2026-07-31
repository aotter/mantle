import {
  MANTLE_BIND_KEYWORD,
  MANTLE_BIND_VALUES,
  type MantleBindValue,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { HandlerContext } from "../model/HandlerContext.js";

/**
 * Builtin op input projection + `x-mantle-bind` stamping (POC ADR-0014).
 *
 * Two transforms applied to `Procedure.input` before it lands in
 * `EntryRepository`:
 *
 *   1. **Projection**: copy only the keys declared on the target
 *      Schema's `spec.schema.properties`. Side-channel fields (CAPTCHA
 *      tokens, hCaptcha challenges, etc.) declared in the Procedure's
 *      input but not in the Schema's properties are silently dropped
 *      from the row. They remain available as the input to matching
 *      synchronous `before_*` lifecycle hooks only.
 *
 *   2. **Stamping**: any Schema property carrying `x-mantle-bind: <value>`
 *      gets its value computed at write time:
 *        - `ctx.user` → `ctx.user?.id ?? null`
 *        - `ctx.staff` → `ctx.staff?.id ?? null`
 *        - `now` → `clockNow` (caller-supplied; lets the use case
 *          share its `Clock` so created/updated stamps line up)
 *
 * Stamping overrides whatever the caller passed for that key —
 * declarative server-stamping is the contract.
 *
 * Pure stateless service — no I/O. Lives in `domain/service/`.
 */
export interface ProjectAndStampArgs {
  readonly schema: SchemaManifest;
  readonly input: Record<string, unknown>;
  readonly ctx: HandlerContext;
  readonly clockNow: number;
}

export function projectAndStamp(args: ProjectAndStampArgs): Record<string, unknown> {
  const properties =
    (args.schema.spec.schema as { properties?: Record<string, unknown> }).properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, propDef] of Object.entries(properties)) {
    const bind = bindValueOf(propDef);
    if (bind) {
      out[key] = computeBind(bind, args.ctx, args.clockNow);
      continue;
    }
    if (key in args.input) {
      out[key] = args.input[key];
    }
  }
  return out;
}

export interface ProjectUpdateAndStampArgs {
  readonly schema: SchemaManifest;
  readonly existing: Record<string, unknown>;
  readonly patch: Record<string, unknown>;
  readonly ctx: HandlerContext;
  readonly clockNow: number;
}

/**
 * Project update data through the same Schema-declared field allowlist
 * while preserving existing server-stamped values. This keeps direct
 * authoring paths (MCP/admin) from accepting arbitrary blob keys, but
 * avoids turning `x-mantle-bind: now` fields into "update timestamp"
 * fields on every draft edit.
 */
export function projectUpdateAndStamp(args: ProjectUpdateAndStampArgs): Record<string, unknown> {
  const properties =
    (args.schema.spec.schema as { properties?: Record<string, unknown> }).properties ?? {};
  const merged = { ...args.existing, ...args.patch };
  const out: Record<string, unknown> = {};
  for (const [key, propDef] of Object.entries(properties)) {
    const bind = bindValueOf(propDef);
    if (bind) {
      out[key] = key in args.existing
        ? args.existing[key]
        : computeBind(bind, args.ctx, args.clockNow);
      continue;
    }
    if (key in merged) {
      out[key] = merged[key];
    }
  }
  return out;
}

function bindValueOf(propDef: unknown): MantleBindValue | undefined {
  if (typeof propDef !== "object" || propDef === null) return undefined;
  const v = (propDef as Record<string, unknown>)[MANTLE_BIND_KEYWORD];
  if (typeof v === "string" && (MANTLE_BIND_VALUES as readonly string[]).includes(v)) {
    return v as MantleBindValue;
  }
  return undefined;
}

function computeBind(bind: MantleBindValue, ctx: HandlerContext, clockNow: number): unknown {
  switch (bind) {
    case "ctx.user":
      return ctx.user?.id ?? null;
    case "ctx.staff":
      return ctx.staff?.id ?? null;
    case "now":
      return clockNow;
  }
}
