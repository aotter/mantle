import { afterEach, expect, test, vi } from "vitest";
import { assertionJson, requestOptions, signInWithPasskey } from "./passkey";

afterEach(() => vi.unstubAllGlobals());

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

test("without the browser's JSON parser, options decode base64url challenge and credential ids", () => {
  vi.stubGlobal("PublicKeyCredential", undefined);
  const options = requestOptions({ challenge: "AQID_w", rpId: "example.test", allowCredentials: [{ id: "BAU", type: "public-key", transports: ["internal"] }] });
  expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([1, 2, 3, 255]);
  expect([...new Uint8Array(options.allowCredentials![0]!.id as ArrayBuffer)]).toEqual([4, 5]);
  expect(options.allowCredentials![0]).toMatchObject({ type: "public-key", transports: ["internal"] });
  expect(options.rpId).toBe("example.test");
});

test("the browser's parser and toJSON are used when present", () => {
  const parsed = { challenge: bytes(9) };
  vi.stubGlobal("PublicKeyCredential", { parseRequestOptionsFromJSON: vi.fn(() => parsed) });
  expect(requestOptions({ challenge: "CQ" })).toBe(parsed);
  expect(assertionJson({ toJSON: () => ({ id: "native" }) } as unknown as PublicKeyCredential)).toEqual({ id: "native" });
});

test("without toJSON, the assertion encodes every binary field as base64url", () => {
  const credential = {
    id: "id-1", rawId: bytes(1, 2), type: "public-key", authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: { clientDataJSON: bytes(3), authenticatorData: bytes(4), signature: bytes(251, 255), userHandle: null },
  } as unknown as PublicKeyCredential;
  expect(assertionJson(credential)).toEqual({
    id: "id-1", rawId: "AQI", type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
    response: { clientDataJSON: "Aw", authenticatorData: "BA", signature: "-_8", userHandle: undefined },
  });
});

test("sign-in posts the assertion with the OAuth query and returns Better Auth's continuation URL", async () => {
  vi.stubGlobal("PublicKeyCredential", undefined);
  const get = vi.fn(async () => ({ toJSON: () => ({ id: "c1" }) }));
  vi.stubGlobal("navigator", { credentials: { get } });
  const fetch = vi.fn(async (url: string) => url.endsWith("/generate-authenticate-options")
    ? Response.json({ challenge: "AQ" })
    : Response.json({ url: "/api/auth/oauth2/authorize?x=1" }));
  vi.stubGlobal("fetch", fetch);
  expect(await signInWithPasskey("/api/auth", "client_id=a&sig=s")).toBe("/api/auth/oauth2/authorize?x=1");
  expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ response: { id: "c1" }, oauth_query: "client_id=a&sig=s" });
  // a refused verification throws, so the page shows its error and stays
  fetch.mockImplementation(async (url: string) => url.endsWith("/generate-authenticate-options") ? Response.json({ challenge: "AQ" }) : new Response("no", { status: 401 }));
  await expect(signInWithPasskey("/api/auth", undefined)).rejects.toThrow("401");
});
