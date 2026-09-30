/**
 * Helper for the Sign In with Apple `clientSecret` field.
 *
 * Apple's "client secret" is **not** an OAuth client secret — it is
 * an ES256-signed JWT the relying party generates from:
 *
 *   - Team ID  (Apple Developer team identifier, 10 chars)
 *   - Key ID   (the Sign-In key id, 10 chars; visible in Apple Developer)
 *   - Private key (the `.p8` file Apple lets you download once)
 *   - Audience (typically the Services ID — same as the Better Auth
 *     `clientId` you pass for `provider: "apple"`)
 *
 * The JWT lives at most 180 days per Apple's policy. This helper
 * defaults to 30 days; **the adopter is responsible for regenerating
 * the JWT before it expires** (e.g. on deploy, or via a scheduled
 * worker). A long-lived Cloudflare isolate can outlive the default,
 * and Apple will reject signin attempts with an expired secret —
 * don't rely on isolate restart cadence for rotation.
 *
 * Built on `crypto.subtle` (native to Workers) — no `node:crypto`, no
 * JWT deps.
 *
 * # Adopter usage
 *
 * ```ts
 * const appleSecret = await appleClientSecret({
 *   teamId: env.APPLE_TEAM_ID,
 *   keyId: env.APPLE_KEY_ID,
 *   privateKey: env.APPLE_PRIVATE_KEY,  // contents of the .p8 file
 *   audience: env.APPLE_SERVICES_ID,    // your Services ID
 * });
 * const auth = createMantleAuth({
 *   // Host-trusted ingress header(s). Cloudflare createAuth() wraps this
 *   // constructor and supplies the platform header automatically.
 *   ipAddressHeaders: ["x-real-ip"],
 *   methods: [{
 *     kind: "social",
 *     provider: "apple",
 *     options: {
 *       clientId: env.APPLE_SERVICES_ID,
 *       clientSecret: appleSecret,
 *     },
 *   }],
 *   // ...
 * });
 * ```
 *
 * `env.APPLE_PRIVATE_KEY` is the multi-line PEM contents of the `.p8`
 * file (set via `wrangler secret put APPLE_PRIVATE_KEY` — paste the
 * whole file when prompted). The helper also accepts the bare
 * base64-encoded DER if the PEM wrapping doesn't survive your secret
 * pipeline.
 */

export interface AppleClientSecretArgs {
  /** Apple Developer team identifier (10 chars). */
  readonly teamId: string;
  /** Sign-In key id (10 chars). */
  readonly keyId: string;
  /**
   * `.p8` file contents — either PEM-wrapped
   * (`-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----`)
   * or just the base64 of the DER.
   */
  readonly privateKey: string;
  /** Typically the Services ID — same string you pass for `clientId`. */
  readonly audience: string;
  /**
   * JWT lifetime in seconds. Apple caps at 180 days
   * (`180 * 24 * 60 * 60 = 15552000`); the default here is 30 days.
   * The helper rejects values above Apple's cap.
   */
  readonly expiresInSeconds?: number;
}

const DEFAULT_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60; // 30 days
const APPLE_MAX_EXPIRES_IN_SECONDS = 180 * 24 * 60 * 60; // 180 days
const APPLE_TOKEN_AUDIENCE_ISSUER = "https://appleid.apple.com";

export async function appleClientSecret(
  args: AppleClientSecretArgs,
): Promise<string> {
  const expiresIn = args.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    // `Number.isFinite` filters NaN / Infinity — without it, NaN slips
    // through `<= 0` and lands as `exp: NaN` → JSON serialises null
    // → Apple rejects opaquely. Catch at the boundary with a clear msg.
    throw new Error(
      "appleClientSecret: expiresInSeconds must be a positive finite number",
    );
  }
  if (expiresIn > APPLE_MAX_EXPIRES_IN_SECONDS) {
    throw new Error(
      `appleClientSecret: expiresInSeconds ${expiresIn} exceeds Apple's 180-day max (${APPLE_MAX_EXPIRES_IN_SECONDS}).`,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: args.keyId };
  const payload = {
    iss: args.teamId,
    iat: now,
    exp: now + expiresIn,
    aud: APPLE_TOKEN_AUDIENCE_ISSUER,
    sub: args.audience,
  };
  const headerB64 = base64UrlEncode(textEncoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await importApplePrivateKey(args.privateKey);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textEncoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

const textEncoder = new TextEncoder();

const PEM_MARKERS_RE = /-----(?:BEGIN|END) [^-]+-----/g;

async function importApplePrivateKey(input: string): Promise<CryptoKey> {
  const der = decodePrivateKeyToDer(input);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function decodePrivateKeyToDer(input: string): Uint8Array<ArrayBuffer> {
  // Strip PEM markers + all whitespace; tolerate the bare-base64 path too.
  const body = input.replace(PEM_MARKERS_RE, "").replace(/\s+/g, "");
  if (body.length === 0) {
    throw new Error(
      "appleClientSecret: privateKey is empty after stripping the PEM wrapper.",
    );
  }
  try {
    return base64ToBytes(body);
  } catch {
    throw new Error(
      "appleClientSecret: privateKey is not valid base64 — paste the contents of your .p8 file (PEM or base64).",
    );
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
