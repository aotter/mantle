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
    const calls: string[] = [];
    // A minimal 2025 stateless MCP endpoint: initialize, then one tool call
    // that fails with a Mantle diagnostic.
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const message = JSON.parse(String(init.body)) as { id?: number; method: string };
      calls.push(message.method);
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "admin", version: "1" },
      } });
      return Response.json({ jsonrpc: "2.0", id: message.id, result: {
        isError: true, content: [{ type: "text", text: JSON.stringify({ diagnostics: [diagnostic] }) }],
      } });
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("location", new URL("https://admin.example.test/admin"));
    await expect(callStaffTool("update_record_posts", { id: "x", expected_version: 1 }))
      .rejects.toMatchObject({ message: "Stale version", body: diagnostic });
    expect(calls.filter((method) => method === "tools/call")).toHaveLength(1);
  });
});
