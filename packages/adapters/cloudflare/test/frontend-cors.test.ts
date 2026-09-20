import { expect, it, vi } from "vitest";
import { withFrontendCors } from "../src/mount/frontendCors.js";

it("allows exact browser origins without granting cookie access; denies hostile preflights", async () => {
  const run = vi.fn(async () => new Response("private", { headers: { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" } }));
  const request = (origin: string, extra: RequestInit = {}) => new Request("https://tenant.test/api/views/posts", { ...extra, headers: { origin, ...extra.headers } });
  const allowed = await withFrontendCors(request("https://frontend.test"), ["https://frontend.test"], run);
  expect(allowed.headers.get("access-control-allow-origin")).toBe("https://frontend.test");
  expect(allowed.headers.has("access-control-allow-credentials")).toBe(false);
  expect(allowed.headers.get("cache-control")).toBe("private, no-store");
  const denied = await withFrontendCors(request("https://evil.test"), ["https://frontend.test"], run);
  expect(denied.headers.has("access-control-allow-origin")).toBe(false);
  const preflight = await withFrontendCors(request("https://evil.test", { method: "OPTIONS", headers: { "access-control-request-method": "POST" } }), ["https://frontend.test"], run);
  expect(preflight.status).toBe(403);
  expect(run).toHaveBeenCalledTimes(2);
  await expect(withFrontendCors(request('https://frontend.test'), ['ftp://localhost'], run)).rejects.toThrow();
  await expect(withFrontendCors(request('https://frontend.test'), ['https://frontend.test/'], run)).rejects.toThrow();
});
