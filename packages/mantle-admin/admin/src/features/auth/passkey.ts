/**
 * Passkey sign-in through Better Auth's passkey plugin, with the browser's own WebAuthn API: no client library.
 * `GET <auth>/passkey/generate-authenticate-options` returns the request options as JSON (it also sets the challenge
 * cookie); the signed assertion goes back to `POST <auth>/passkey/verify-authentication`, which creates the session.
 */

type Json = Record<string, unknown>;

const fromBase64Url = (value: string): ArrayBuffer => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return bytes.buffer;
};
const toBase64Url = (value: ArrayBuffer | null): string | undefined => {
  if (!value) return undefined;
  let text = "";
  for (const byte of new Uint8Array(value)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type ParseJson = { parseRequestOptionsFromJSON?: (options: Json) => PublicKeyCredentialRequestOptions };

/** The request options as `navigator.credentials.get` takes them; the browser's own parser when it has one. */
export function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  const native = (globalThis.PublicKeyCredential as unknown as ParseJson | undefined)?.parseRequestOptionsFromJSON;
  if (native) return native(json);
  const allow = json.allowCredentials as { id: string; type: "public-key"; transports?: AuthenticatorTransport[] }[] | undefined;
  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: fromBase64Url(json.challenge as string),
    ...(allow ? { allowCredentials: allow.map(c => ({ ...c, id: fromBase64Url(c.id) })) } : {}),
  };
}

/** The assertion as JSON for the server; the browser's own `toJSON` when it has one. */
export function assertionJson(credential: PublicKeyCredential): Json {
  const native = (credential as unknown as { toJSON?: () => Json }).toJSON;
  if (typeof native === "function") return native.call(credential);
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: toBase64Url(response.userHandle),
    },
  };
}

/**
 * Sign in with a passkey. Resolves to the URL to continue to (Better Auth answers an OAuth sign-in with the authorize
 * continuation) or `undefined`; throws when the browser or the server refuses.
 */
export async function signInWithPasskey(authBase: string, oauthQuery: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  const options = await fetch(`${authBase}/passkey/generate-authenticate-options`, { credentials: "include" });
  if (!options.ok) throw new Error(`passkey options ${options.status}`);
  const credential = await navigator.credentials.get({ publicKey: requestOptions(await options.json() as Json), ...(signal ? { signal } : {}) });
  if (!credential) throw new Error("no passkey");
  const verified = await fetch(`${authBase}/passkey/verify-authentication`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response: assertionJson(credential as PublicKeyCredential), ...(oauthQuery ? { oauth_query: oauthQuery } : {}) }),
  });
  if (!verified.ok) throw new Error(`passkey verify ${verified.status}`);
  const body = await verified.json().catch(() => ({})) as { url?: unknown };
  return typeof body.url === "string" ? body.url : undefined;
}
