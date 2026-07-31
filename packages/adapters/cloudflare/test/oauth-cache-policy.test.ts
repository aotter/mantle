import { describe, expect, it } from "vitest";
import { applyCachePolicy } from "../src/oauth/cachePolicy.js";

function responseFor(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/public") {
    return new Response("public", {
      headers: {
        "cache-control": "public, max-age=0, s-maxage=300",
        "cloudflare-cdn-cache-control": "public, s-maxage=86400",
        vary: "Accept-Encoding",
      },
    });
  }
  if (path === "/public-with-cookie") {
    const headers = new Headers({ "cache-control": "public, s-maxage=300" });
    headers.append("set-cookie", "session=secret");
    headers.append("set-cookie", "theme=dark");
    return new Response("public", { headers });
  }
  if (path === "/public-without-freshness") {
    return new Response("public", { headers: { "cache-control": "public" } });
  }
  if (path === "/public-with-invalid-freshness") {
    return new Response("public", {
      headers: { "cache-control": "public, s-maxage=tomorrow" },
    });
  }
  if (path === "/contradictory") {
    return new Response("public", {
      headers: { "cache-control": "public, no-store, s-maxage=300" },
    });
  }
  if (path === "/redirect") {
    return Response.redirect("https://example.test/login", 302);
  }
  if (path === "/error") {
    return new Response("error", { status: 500 });
  }
  return new Response("private", {
    headers: {
      "cdn-cache-control": "public, s-maxage=86400",
      "cloudflare-cdn-cache-control": "public, s-maxage=86400",
    },
  });
}

function request(path: string, init?: RequestInit): Response {
  const incoming = new Request(`https://example.test${path}`, init);
  return applyCachePolicy(incoming, responseFor(incoming));
}

describe("top-level OAuth cache boundary", () => {
  it("keeps only explicit anonymous public responses cacheable", async () => {
    const response = await request("/public");

    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Cookie, Authorization");
  });

  it.each([
    ["cookie request", "/public", { headers: { cookie: "session=secret" } }],
    ["authorized request", "/public", { headers: { authorization: "Bearer secret" } }],
    ["response cookie", "/public-with-cookie", undefined],
    ["missing explicit freshness", "/public-without-freshness", undefined],
    ["invalid freshness", "/public-with-invalid-freshness", undefined],
    ["contradictory directives", "/contradictory", undefined],
    ["headerless response", "/admin", undefined],
    ["redirect", "/redirect", undefined],
    ["error", "/error", undefined],
    ["non-read method", "/public", { method: "POST" }],
  ])("marks %s private", async (_label, path, init) => {
    const response = await request(path, init);

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("removes Cloudflare cache-control overrides from private responses", async () => {
    const response = await request("/admin");

    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
  });

  it("preserves every Set-Cookie value while making the response private", async () => {
    const response = await request("/public-with-cookie");
    const cookies = response.headers.get("set-cookie");

    expect(cookies).toContain("session=secret");
    expect(cookies).toContain("theme=dark");
  });

  it("also protects headerless OAuth-provider responses", async () => {
    const response = await request("/.well-known/oauth-authorization-server");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
