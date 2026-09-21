import { describe, expect, it } from "vitest";
import { appleClientSecret } from "../src/appleClientSecret.js";

/**
 * Tests `appleClientSecret` end-to-end against a real ECDSA P-256
 * key pair (generated per-test). We can't use a real Apple `.p8`
 * (no way to ship one safely); generating an ephemeral key gives us
 * a verifiable signature with the matching public key.
 */

const PEM_HEADER = "-----BEGIN PRIVATE KEY-----";
const PEM_FOOTER = "-----END PRIVATE KEY-----";

async function generateEphemeralKeyPair(): Promise<{
  privateKeyPem: string;
  privateKeyBase64: string;
  publicKey: CryptoKey;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const base64 = btoa(
    String.fromCharCode(...new Uint8Array(pkcs8)),
  );
  // 64-char line wrapping is how openssl emits .p8; we don't require
  // the helper to handle wrap, but using it here exercises the
  // whitespace-tolerant decoder.
  const wrapped = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  const pem = `${PEM_HEADER}\n${wrapped}\n${PEM_FOOTER}`;
  return { privateKeyPem: pem, privateKeyBase64: base64, publicKey: pair.publicKey };
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyJwt(
  jwt: string,
  publicKey: CryptoKey,
): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown> }> {
  const parts = jwt.split(".");
  expect(parts.length).toBe(3);
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))) as Record<
    string,
    unknown
  >;
  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadB64)),
  ) as Record<string, unknown>;
  const sig = base64UrlDecode(sigB64);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    sig,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  expect(ok).toBe(true);
  return { header, payload };
}

describe("appleClientSecret", () => {
  it("signs a JWT verifiable with the corresponding public key (PEM private key)", async () => {
    const { privateKeyPem, publicKey } = await generateEphemeralKeyPair();
    const jwt = await appleClientSecret({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: privateKeyPem,
      audience: "com.example.web",
    });
    const { header, payload } = await verifyJwt(jwt, publicKey);
    expect(header).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(payload.iss).toBe("TEAM123456");
    expect(payload.aud).toBe("https://appleid.apple.com");
    expect(payload.sub).toBe("com.example.web");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
  });

  it("accepts bare base64 (no PEM wrapper)", async () => {
    const { privateKeyBase64, publicKey } = await generateEphemeralKeyPair();
    const jwt = await appleClientSecret({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: privateKeyBase64,
      audience: "com.example.web",
    });
    await verifyJwt(jwt, publicKey);
  });

  it("defaults expiresInSeconds to 30 days", async () => {
    const { privateKeyPem, publicKey } = await generateEphemeralKeyPair();
    const jwt = await appleClientSecret({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: privateKeyPem,
      audience: "com.example.web",
    });
    const { payload } = await verifyJwt(jwt, publicKey);
    const lifetime = (payload.exp as number) - (payload.iat as number);
    expect(lifetime).toBe(30 * 24 * 60 * 60);
  });

  it("honours custom expiresInSeconds", async () => {
    const { privateKeyPem, publicKey } = await generateEphemeralKeyPair();
    const jwt = await appleClientSecret({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: privateKeyPem,
      audience: "com.example.web",
      expiresInSeconds: 3600,
    });
    const { payload } = await verifyJwt(jwt, publicKey);
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it("rejects expiresInSeconds above Apple's 180-day max", async () => {
    const { privateKeyPem } = await generateEphemeralKeyPair();
    await expect(
      appleClientSecret({
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        privateKey: privateKeyPem,
        audience: "com.example.web",
        expiresInSeconds: 200 * 24 * 60 * 60,
      }),
    ).rejects.toThrow(/180-day max/);
  });

  it("rejects non-positive expiresInSeconds", async () => {
    const { privateKeyPem } = await generateEphemeralKeyPair();
    await expect(
      appleClientSecret({
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        privateKey: privateKeyPem,
        audience: "com.example.web",
        expiresInSeconds: 0,
      }),
    ).rejects.toThrow(/positive finite number/);
  });

  it("rejects NaN expiresInSeconds (would silently produce exp: null)", async () => {
    const { privateKeyPem } = await generateEphemeralKeyPair();
    await expect(
      appleClientSecret({
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        privateKey: privateKeyPem,
        audience: "com.example.web",
        expiresInSeconds: Number.NaN,
      }),
    ).rejects.toThrow(/positive finite number/);
  });

  it("rejects Infinity expiresInSeconds", async () => {
    const { privateKeyPem } = await generateEphemeralKeyPair();
    await expect(
      appleClientSecret({
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        privateKey: privateKeyPem,
        audience: "com.example.web",
        expiresInSeconds: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow(/positive finite number/);
  });

  it("accepts exactly Apple's 180-day max", async () => {
    const { privateKeyPem, publicKey } = await generateEphemeralKeyPair();
    const APPLE_MAX = 180 * 24 * 60 * 60;
    const jwt = await appleClientSecret({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: privateKeyPem,
      audience: "com.example.web",
      expiresInSeconds: APPLE_MAX,
    });
    const { payload } = await verifyJwt(jwt, publicKey);
    expect((payload.exp as number) - (payload.iat as number)).toBe(APPLE_MAX);
  });

  it("rejects an empty privateKey", async () => {
    await expect(
      appleClientSecret({
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        privateKey: "",
        audience: "com.example.web",
      }),
    ).rejects.toThrow(/empty/);
  });

  it("rejects garbled (non-base64) privateKey with a clear message", async () => {
    await expect(
      appleClientSecret({
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        // Invalid base64 — contains non-base64 chars
        privateKey: "this is not a key !!!",
        audience: "com.example.web",
      }),
    ).rejects.toThrow();
  });
});
