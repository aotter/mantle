import { describe, expect, it } from "vitest";
import { defineAdmin, type AdminMeta } from "../src/app/define-admin";

/** What `generated/admin-client.ts` records for each View: its row and whether it is an admin MCP tool (true or null). */
interface Types {
  readonly views: {
    readonly "pending-requests": { readonly input: object; readonly row: { readonly id: string }; readonly mcp: true };
    readonly "internal-audit": { readonly input: object; readonly row: { readonly id: string }; readonly mcp: null };
  };
  readonly collections: { readonly requests: { readonly data: { readonly title: string } } };
  readonly operations: Record<never, never>;
}
const admin: AdminMeta<Types> = {};

// tsc checks this file (`pnpm typecheck`): a `// @ts-expect-error` that stops erroring fails it
describe("pages[].mcp", () => {
  it("names a View that has an admin MCP tool, and keeps it as given", () => {
    const page = { path: "queue", title: "Queue", element: <p>queue</p>, mcp: { renders: "pending-requests" } } as const;
    expect(defineAdmin(admin, { pages: [page] }).pages[0]!.mcp).toEqual({ renders: "pending-requests" });
    expect(defineAdmin(admin, { pages: [{ path: "plain", title: "Plain", element: <p>plain</p> }] }).pages[0]!.mcp).toBeUndefined();
  });

  it("refuses a View without an admin MCP tool, and a misspelt View", () => {
    // @ts-expect-error this View has no admin MCP tool, so no host can open it
    defineAdmin(admin, { pages: [{ path: "audit", title: "Audit", element: null, mcp: { renders: "internal-audit" } }] });
    // @ts-expect-error a misspelt View
    defineAdmin(admin, { pages: [{ path: "queue", title: "Queue", element: null, mcp: { renders: "pending-request" } }] });
    // @ts-expect-error a collection is not a View
    defineAdmin(admin, { pages: [{ path: "queue", title: "Queue", element: null, mcp: { renders: "requests" } }] });
  });

  it("accepts any View name where there are no generated types (the built-in entry)", () => {
    expect(defineAdmin({} as AdminMeta, { pages: [{ path: "queue", title: "Queue", element: null, mcp: { renders: "anything" } }] }).pages[0]!.mcp).toEqual({ renders: "anything" });
  });
});
