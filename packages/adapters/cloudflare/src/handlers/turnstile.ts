import {
  InvokeFailure,
  type HandlerContext,
} from "@aotter/mantle-runtime";
import { runtimeDiagnostic } from "@aotter/mantle-spec";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface TurnstileVerifyResponse {
  readonly success: boolean;
  readonly "error-codes"?: readonly string[];
}

export interface CloudflareTurnstileCheckOptions {
  /** Server-side secret. Pulled from `env.TURNSTILE_SECRET_KEY` by the
   *  factory. The literal string `"dev-stub"` short-circuits to a
   *  local check (`token === "fail"` is rejected, anything else
   *  passes) — useful for integration smokes that run with no
   *  network. Any other value triggers real `siteverify`. */
  readonly secret: string;
  /** Field name on the procedure input carrying the client-side
   *  widget token. Defaults to `"turnstileToken"` (matches the
   *  starter's contact-messages Schema). */
  readonly tokenField?: string;
}

/**
 * `before_create` (or any pre-mutation) hook that verifies a
 * Cloudflare Turnstile token. Builtin handler factory — register
 * with:
 *
 *     register("captchaCheck", cloudflareTurnstileCheck({
 *       secret: env.TURNSTILE_SECRET_KEY ?? "dev-stub",
 *     }));
 *
 * Behavior:
 *
 *   - Authenticated callers (`ctx.user` non-null) bypass — the gate
 *     guards anonymous public-form abuse, not signed-in writes
 *     (admin UI, MCP agents).
 *   - `secret === "dev-stub"`: short-circuit. `token === "fail"`
 *     rejects; anything else passes. Tests assert on this token
 *     shape; integration runs need no network.
 *   - Otherwise: POSTs to `siteverify`, fails on `{ success: false }`
 *     or any HTTP error.
 *
 * Throws `InvokeFailure(AUTH_DENIED)` on rejection so the procedure
 * mount maps it to HTTP 403, the right code for "your form
 * submission was rejected by abuse-prevention." A plain `Error`
 * surfaces as INTERNAL_ERROR (500) and falsely implies a server
 * bug.
 */
export function cloudflareTurnstileCheck(options: CloudflareTurnstileCheckOptions) {
  const { secret, tokenField = "turnstileToken" } = options;
  return async function turnstileCheck(
    input: unknown,
    ctx: HandlerContext,
  ): Promise<{ ok: true }> {
    if (ctx.user) return { ok: true };
    const tokenRaw = typeof input === "object" && input !== null
      ? Reflect.get(input, tokenField)
      : undefined;
    const token = typeof tokenRaw === "string" ? tokenRaw : "";
    if (!token) reject("missing turnstile token");
    if (secret === "dev-stub") {
      if (token === "fail") reject("dev-stub rejected literal 'fail' token");
      return { ok: true };
    }
    const verified = await verifyWithTurnstile(secret, token);
    if (!verified.success) {
      reject(
        `Turnstile siteverify rejected: ${(verified["error-codes"] ?? ["unknown"]).join(", ")}`,
      );
    }
    return { ok: true };
  };
}

async function verifyWithTurnstile(secret: string, token: string): Promise<TurnstileVerifyResponse> {
  const body = new URLSearchParams({ secret, response: token });
  const res = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) reject(`Turnstile siteverify HTTP ${res.status}`);
  return (await res.json()) as TurnstileVerifyResponse;
}

function reject(detail: string): never {
  throw new InvokeFailure(
    runtimeDiagnostic({
      code: "AUTH_DENIED",
      severity: "error",
      path: "captcha-check",
      expected: "valid Turnstile token verified by siteverify",
      message: `CAPTCHA verification failed: ${detail}.`,
    }),
  );
}
