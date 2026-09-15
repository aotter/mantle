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
  it("preserves MCP failure facts and never retries", async () => {
    const diagnostic = { code: "CONFLICT", message: "Stale version" };
    const fetcher = vi.fn(async () => Response.json({ error: { message: diagnostic.message, data: diagnostic } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(callStaffTool("update_record_posts", { id: "x", expected_version: 1 })).rejects.toMatchObject({ body: diagnostic });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
