/**
 * An app with no MCP-visible operation (only a Schema, or only internal Views) still gets `generated/mcp.ts`, which the
 * app shell imports statically. Served as the shell serves it, with the Admin MCP App, its empty `tools` table answers.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { mcp } from "@aotter/mantle/mcp";
import { sdkFixtureCaller as fixtureCaller } from "../../../mantle/tests/apps/fixtures.js";
import { adminMcpApps } from "../../src/server/mcp.js";
import { ERAS, mcpInit } from "../../test/mcp-wire.js";
import { generateAdmin, writeAdminFixture } from "./generated-fixture.js";

const schema = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  searchableFields: [title]
  schema: {type: object, readOnly: true, required: [title], properties: {title: {type: string}}}
`;
const internal = `${schema}---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: note_titles}
spec: {surface: internal, sql: 'SELECT title FROM notes ORDER BY id'}
`;
const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));
const admin = fixtureCaller({
  kind: "user",
  subject: "a",
  role: "admin",
  admin: true,
  credential: "oauth",
  scopes: ["mcp"],
  credentialId: null,
  clientId: null,
});
type Env = { ASSETS: { fetch(request: Request): Promise<Response> } };
const env: Env = { ASSETS: { fetch: async () => new Response("<head></head><p>admin</p>") } };

for (const [name, text] of [
  ["only a Schema", schema],
  ["only an internal View", internal],
] as const)
  test(`${name}: every target emits mcp.ts with an empty tools table, and it serves server/discover, tools/list and resources/list`, async () => {
    for (const target of ["bun-sqlite", "cloudflare-d1", "bun-postgres", "cloudflare-postgres"] as const) {
      const files = await generateAdmin(target, text);
      expect(files["mcp.ts"]).toContain("export const tools");
      expect(files["mcp.ts"]).toContain("export function mcp");
      const dir = await mkdtemp(join(import.meta.dir, ".empty-mcp-"));
      dirs.push(dir);
      await writeAdminFixture(dir, files);
      const { tools, mcp: generated } = await import(join(dir, "mcp.ts"));
      const { mcpAppCatalogues } = await import(join(dir, "admin-descriptors.ts"));
      expect(tools).toEqual([]);
      // As docs/examples/app-shell/src/service.ts wires it, and through the generated mcp().
      const handlers = [
        mcp<Env, null>(tools, {
          db: () => null,
          caller: () => admin,
          authorizationScopes: ["offline_access"],
          apps: { admin: adminMcpApps({ catalogue: mcpAppCatalogues.admin }) },
        }),
        generated({ db: () => null, caller: () => admin }),
      ];
      for (const api of handlers)
        for (const path of ["/mcp", "/mcp/admin"])
          for (const era of ERAS) {
            const rpc = async (method: string, params: Record<string, unknown> = {}) => {
              const response = await api(new Request(`https://app.test${path}`, mcpInit(method, params, { era })), env);
              const body = await response!.text();
              expect(response!.status).toBe(200);
              return JSON.parse(body.startsWith("event:") ? body.split("data: ")[1]!.split("\n")[0]! : body);
            };
            // The connect step of each era: `initialize` (2025) or `server/discover` (2026-07-28).
            const discovered =
              era === "2026-07-28"
                ? await rpc("server/discover")
                : await rpc("initialize", {
                    protocolVersion: era,
                    capabilities: {},
                    clientInfo: { name: "test", version: "1" },
                  });
            expect(discovered.result.capabilities.tools).toBeDefined();
            expect((await rpc("tools/list")).result.tools).toEqual([]);
            if (path === "/mcp/admin" && api === handlers[0])
              expect((await rpc("resources/list")).result.resources).toBeArray();
          }
    }
  });
