import { describe, expect, it, vi, afterEach } from "vitest";
import { adminPath, callStaffTool, resultPath } from "../src/lib/admin-tools";

afterEach(() => vi.unstubAllGlobals());
describe("Admin tool transport and routing", () => {
  it("rejects external, API, and normalized escape paths", () => {
    for (const path of ["https://evil.test", "//evil.test/admin", "/admin/../api/delete", "/admin/api/mcp", "/administrator", "/admin/\\evil", "/admin/auth/x"]) expect(() => adminPath(path)).toThrow();
    expect(adminPath("/admin/c/posts?status=draft")).toBe("/admin/c/posts?status=draft");
  });
  it("navigates only to known result targets and encodes entry IDs", () => {
    const catalog = { tools: [], routes: { create: { path: "/admin/c/posts", entry: true } } };
    expect(resultPath(catalog, "create", { id: "a/b", status: "draft" })).toBe("/admin/c/posts/a%2Fb?status=draft");
    expect(resultPath(catalog, "unknown", { id: "x" })).toBeUndefined();
  });
  it("runs a tool once on Admin's tool route, with its input as the JSON body", async () => {
    const seen: [string, string | undefined, string | undefined][] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push([url, init?.method, init?.body as string | undefined]);
      return Response.json({ output: { title: "x" } });
    }));
    expect(await callStaffTool("re/title", { id: "a", tags: ["x"], assignee: null })).toEqual({ output: { title: "x" }, result: { content: [{ type: "text", text: '{"title":"x"}' }], structuredContent: { title: "x" } } });
    expect(seen).toEqual([["/admin/api/webmcp/re%2Ftitle", "POST", JSON.stringify({ id: "a", tags: ["x"], assignee: null })]]);
  });
  it("keeps the refusal's Mantle diagnostic as a plain body, and never retries", async () => {
    const diagnostic = { code: "CONFLICT", message: "Stale version" };
    const fetcher = vi.fn(async () => Response.json({ error: diagnostic }, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(callStaffTool("retitle", { id: "x", expected_version: 1 })).rejects.toMatchObject({ message: "Stale version", status: 409, body: diagnostic });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
