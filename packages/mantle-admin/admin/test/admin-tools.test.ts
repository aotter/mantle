import { describe, expect, it, vi, afterEach } from "vitest";
import { adminPath, callAdminTool, navigationTools, resultPath, toolFailure } from "../src/lib/admin-tools";

afterEach(() => vi.unstubAllGlobals());
describe("Admin tool transport and routing", () => {
  it("rejects external, API, and normalized escape paths", () => {
    for (const path of ["https://evil.test", "//evil.test/admin", "/admin/../api/delete", "/admin/api/mcp", "/administrator", "/admin/\\evil", "/admin/auth/x"]) expect(() => adminPath(path)).toThrow();
    expect(adminPath("/admin/c/posts?status=draft")).toBe("/admin/c/posts?status=draft");
  });
  it("gives the navigation tools a title and read-only, non-destructive hints", () => {
    expect(navigationTools.map(({ name, title, annotations }) => [name, title, annotations])).toEqual([
      ["admin_get_context", "Admin get context", { readOnlyHint: true, destructiveHint: false }],
      ["admin_navigate", "Admin navigate", { readOnlyHint: true, destructiveHint: false }],
    ]);
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
    expect(await callAdminTool("re/title", { id: "a", tags: ["x"], assignee: null })).toEqual({ output: { title: "x" }, result: { content: [{ type: "text", text: '{"title":"x"}' }], structuredContent: { title: "x" } } });
    expect(seen).toEqual([["/admin/api/webmcp/re%2Ftitle", "POST", JSON.stringify({ id: "a", tags: ["x"], assignee: null })]]);
  });
  it("tells the model the deployed tool version the route reports", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ output: { title: "x" }, version: "0a1b2c3d" })));
    expect((await callAdminTool("retitle", {})).result.content).toEqual([{ type: "text", text: '{"title":"x"}' }, { type: "text", text: "tool version 0a1b2c3d" }]);
  });
  it("answers a refusal with the deployed tool version and current input schema, as MCP does", async () => {
    const diagnostic = { code: "INPUT_VALIDATION_FAILED", message: "title is too short.", path: "title", toolVersion: "0a1b2c3d", inputSchema: { type: "object", required: ["title"] } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: diagnostic }, { status: 400 })));
    const failure = toolFailure(await callAdminTool("retitle", {}).catch((error: unknown) => error));
    expect(failure).toEqual({ isError: true, content: [{ type: "text", text: "title is too short." }, { type: "text", text: 'tool version 0a1b2c3d; input schema {"type":"object","required":["title"]}' }], structuredContent: { diagnostic } });
    expect(toolFailure(new TypeError("Unknown admin tool."))).toEqual({ isError: true, content: [{ type: "text", text: "Unknown admin tool." }] });
  });
  it("keeps the refusal's Mantle diagnostic as a plain body, and never retries", async () => {
    const diagnostic = { code: "CONFLICT", message: "Stale version" };
    const fetcher = vi.fn(async () => Response.json({ error: diagnostic }, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(callAdminTool("retitle", { id: "x", expected_version: 1 })).rejects.toMatchObject({ message: "Stale version", status: 409, body: diagnostic });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
