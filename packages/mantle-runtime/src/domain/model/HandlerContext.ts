import type { LifecycleHook, StaffRole } from "@aotter/mantle-spec";
import type { EntryRow } from "./EntryRow.js";

/**
 * `HandlerContext` — auth + bindings handed to every Procedure
 * handler. The dispatcher fills this from the request:
 *
 *   - Anonymous request:  `{ user: null, staff: null }`
 *   - Logged-in user:     `{ user: { id }, staff: null }`
 *   - Staff member:       `{ user: { id }, staff: { id, role } }`
 *
 * `staff.id` equals `user.id` — staff is a privilege overlay on users
 * (see `domain/model/Staff`), not a separate identity. Both are kept
 * on the context for handler ergonomics.
 *
 * Lives in `domain/model/` (not `usecase/dto/`) because it's a
 * value-typed concept used by domain / usecase / infrastructure
 * alike — it's a per-request VO, not a request DTO.
 */
export interface HandlerContext<Env = unknown> {
  readonly user: { readonly id: string } | null;
  readonly staff: { readonly id: string; readonly role: StaffRole } | null;
  /** Verified credential metadata normalized by the adapter. Raw
   *  credentials never enter runtime context. Optional preserves
   *  source compatibility for legacy/internal invocations. */
  readonly auth?: HandlerAuthContext;
  /** Adapter-specific bindings. The default stays portable; consumers may
   *  supply their Worker Env type through `HandlerFn`/generated handlers. */
  readonly env: Env;
  /** Platform `waitUntil`-style fire-and-forget bridge. An adapter may
   *  populate it from Cloudflare `ExecutionContext` or Vercel Functions;
   *  runtime uses it for deferred lifecycle-hook fallback. */
  readonly waitUntil?: (p: Promise<unknown>) => void;
  /** Lifecycle event metadata. Populated by `RunLifecycleHooksUseCase`
   *  when this ctx is passed to a Procedure invoked AS a lifecycle hook
   *  target. Undefined on standard Procedure invocations (HTTP Trigger,
   *  MCP, admin endpoints). */
  readonly event?: HandlerLifecycleEvent;
}

export type CredentialKind = "session" | "oauth" | "api-key" | "personal-token";

export interface HandlerAuthContext {
  readonly credential: CredentialKind;
  /** Opaque site record id or token JTI, never the raw token/key. */
  readonly credentialId: string | null;
  readonly clientId: string | null;
  readonly scopes: readonly string[];
}

export interface HandlerLifecycleEvent {
  /** Stable for one lifecycle event across deferred retries/replays. */
  readonly id: string;
  /** Trigger currently consuming the event. Pair with `id` for an
   *  idempotency key when several Triggers share one event. */
  readonly trigger: string;
  readonly hook: LifecycleHook;
  readonly schema: string;
  /** Pre-mutation row for `before_*` hooks; persisted post-mutation
   *  row for `after_*`. `null` for `before_create` (no row exists). */
  readonly entry: EntryRow | null;
}

/**
 * Procedure handler signature. The dispatcher validates `input`
 * against the Procedure's `input` JSON Schema before calling, so the
 * handler can trust its argument shape; the return is similarly
 * validated against `output`. A handler that returns the wrong shape
 * surfaces as `OUTPUT_VALIDATION_FAILED` to the caller and is a
 * handler bug.
 */
export type HandlerFn<I = unknown, O = unknown, Env = unknown> = (
  input: I,
  ctx: HandlerContext<Env>,
) => Promise<O> | O;

/**
 * Erased handler shape used by the registry. `any` is intentional —
 * `unknown` re-introduces the contravariance problem that makes
 * typed handlers non-assignable. Authors never write this type; it
 * appears only on registry boundaries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHandler = HandlerFn<any, any, any>;
