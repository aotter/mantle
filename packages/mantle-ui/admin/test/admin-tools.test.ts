import { describe, expect, it, vi, afterEach } from "vitest";
import { adminPath, callStaffTool, resultPath } from "../src/lib/admin-tools";

afterEach(() => vi.unstubAllGlobals());
describe("Admin tool transport and routing", () => {
  it("rejects external, API, and normalized escape paths", () => {
    for (const path of ["https://evil.test", "//evil.test/admin", "/admin/../api/delete", "/admin/api/mcp", "/administrator", "/admin/\\evil", "/admin/auth/x"]) expect(() => adminPath(path)).toThrow();
    expect(adminPath("/admin/c/posts?status=draft")).toBe("/admin/c/posts?status=draft");
  });
  it("navigates only to known result targets and encodes entry IDs", () => {
    const catalog = { tools: [], calls: {}, routes: { create: { path: "/admin/c/posts", entry: true } } };
    expect(resultPath(catalog, "create", { id: "a/b", status: "draft" })).toBe("/admin/c/posts/a%2Fb?status=draft");
    expect(resultPath(catalog, "unknown", { id: "x" })).toBeUndefined();
  });
  const catalog = { tools: [], routes: {}, calls: { retitle: { kind: "procedure" as const, source: "re/title" }, report: { kind: "view" as const, source: "report" } } };
  it("runs a Procedure tool on Admin's operation route and a View tool on its View route, once each", async () => {
    const seen: [string, string | undefined, string | undefined][] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push([url, init?.method, init?.body as string | undefined]);
      return Response.json(url.includes("/operations/") ? { ok: true, output: { title: "x" } } : { rows: [{ id: "a" }] });
    }));
    expect(await callStaffTool(catalog, "retitle", { id: "a", title: "x" })).toMatchObject({ output: { title: "x" }, result: { structuredContent: { title: "x" } } });
    expect((await callStaffTool(catalog, "report", { region: "north", limit: 5, skip: undefined })).output).toEqual({ rows: [{ id: "a" }] });
    expect(seen).toEqual([["/admin/api/operations/re%2Ftitle", "POST", JSON.stringify({ id: "a", title: "x" })], ["/admin/api/views/report?region=north&limit=5", undefined, undefined]]);
    await expect(callStaffTool(catalog, "purge", {})).rejects.toThrow("Unknown staff tool.");
    await expect(callStaffTool(catalog, "toString", {})).rejects.toThrow("Unknown staff tool.");
  });
  it("keeps the refusal's Mantle diagnostic as a plain body, and never retries", async () => {
    const diagnostic = { code: "CONFLICT", message: "Stale version" };
    const fetcher = vi.fn(async () => Response.json({ error: diagnostic }, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(callStaffTool(catalog, "retitle", { id: "x", expected_version: 1 })).rejects.toMatchObject({ message: "Stale version", status: 409, body: diagnostic });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
