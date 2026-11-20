/**
 * The app shell `mantle init` writes (docs/examples/app-shell/src/service.ts), run with the real Core and Admin
 * packages and stubbed generated modules and `src/routes.ts`: a response that states no Cache-Control leaves the Worker
 * `private, no-store`; one that states its own keeps it.
 */
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Inside this package, so the shell's `@aotter/mantle*` imports resolve to the built packages.
const app = mkdtempSync(join(import.meta.dir, ".app-shell-"));
afterAll(() => rmSync(app, { recursive: true, force: true }));
mkdirSync(join(app, "generated"));
cpSync(resolve(import.meta.dir, "../../../../docs/examples/app-shell/src/service.ts"), join(app, "src/service.ts"));
for (const [file, source] of Object.entries({
  "generated/admin-bindings.js": "export const adminBindings = () => ({});",
  "generated/rest.js": "export const rest = () => async () => undefined;",
  "generated/mcp.js": "export const tools = [];",
  "generated/admin-descriptors.js": "export const mcpAppCatalogues = {};",
  "src/handlers.js": "export const handlers = {};",
  "src/routes.js": "export const appRoutes = async request => globalThis.route(request);",
}))
  writeFileSync(join(app, file), source);
const routed = globalThis as unknown as { route: (request: Request) => Response | undefined };

test("the app shell defaults a response without Cache-Control to private, no-store and keeps a stated one", async () => {
  const { fetchService } = await import(join(app, "src/service.ts"));
  const env = {
    PUBLIC_ORIGIN: "https://app.test",
    ASSETS: {
      fetch: async (request: Request) =>
        new URL(request.url).pathname === "/favicon.ico"
          ? new Response("icon", { headers: { "cache-control": "public, max-age=0, must-revalidate" } })
          : new Response("missing", { status: 404 }),
    },
  };
  const context = { waitUntil: () => {} };
  const stream = new ReadableStream({ start: controller => controller.enqueue(new TextEncoder().encode("streamed")) });
  const cases: [string, (request: Request) => Response | undefined, string, string][] = [
    ["a bare Response", () => new Response("x"), "/page", "private, no-store"],
    [
      "a route's own header",
      () => new Response("x", { headers: { "cache-control": "public, max-age=60" } }),
      "/page",
      "public, max-age=60",
    ],
    [
      "a redirect (immutable headers)",
      () => Response.redirect("https://app.test/elsewhere", 302),
      "/old",
      "private, no-store",
    ],
    ["a streamed body", () => new Response(stream), "/stream", "private, no-store"],
    ["a file from ASSETS", () => undefined, "/favicon.ico", "public, max-age=0, must-revalidate"],
    ["the 404 fallback", () => undefined, "/missing", "no-store"],
    [
      "a thrown error",
      () => {
        throw new Error("route failed");
      },
      "/page",
      "private, no-store",
    ],
  ];
  const seen = [];
  const log = console.error;
  console.error = () => {};
  try {
    for (const [name, answer, path] of cases) {
      routed.route = answer;
      const response: Response = await fetchService(new Request("https://app.test" + path), env, context);
      seen.push([name, response.headers.get("cache-control")]);
      // The body passes through as the same stream: the default never buffers it.
      if (path === "/stream") expect(response.body).toBe(stream);
      await response.body?.cancel();
    }
  } finally {
    console.error = log;
  }
  expect(seen).toEqual(cases.map(([name, , , expected]) => [name, expected]));
});
