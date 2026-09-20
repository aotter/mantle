import { afterEach, describe, expect, it, vi } from "vitest";
import { linkManifestSet, parseManifestSources, type Manifest } from "@aotter/mantle-spec";
import type { MantleRuntime } from "../src/MantleRuntime.js";
import { compileRuntimePlan } from "../src/domain/service/RuntimePlanCompiler.js";
import * as paths from "../src/domain/service/PathMatcher.js";
import { createMantleRequestHandler } from "../src/infrastructure/http/createMantleRequestHandler.js";

afterEach(() => vi.restoreAllMocks());

function fixture(routePaths: readonly string[]) {
  const apiVersion = "cms.mantle.aotter.net/v1" as const;
  const manifests: Manifest[] = [{ apiVersion, kind: "Procedure", metadata: { name: "echo" },
    spec: { input: { type: "object" }, output: { type: "object" }, handler: { kind: "ref", ref: "echo" } },
  }, ...routePaths.map((path, index): Manifest => ({
    apiVersion, kind: "Trigger", metadata: { name: `route-${index}` },
    spec: { source: { kind: "http", method: "POST", path }, target: { procedure: "echo" } },
  }))];
  const parsed = parseManifestSources({ sources: manifests.map((value, index) => ({ sourceId: `memory:${index}`, text: JSON.stringify(value) })) });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const invokeTrigger = vi.fn(async (request) => ({ ok: true, data: { trigger: request.trigger, ...request.input } }));
  return { plan: compiled.value, invokeTrigger, getRuntime: async () => ({ invokeTrigger }) as unknown as MantleRuntime };
}

const request = (path: string, method = "POST") => new Request(`https://site.test${path}`, {
  method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: '{"id":"spoofed"}' } : {}),
});

describe("portable indexed Trigger transport", () => {
  it("rejects oversized JSON before a Trigger can run", async () => {
    const options = fixture(["/api/items"]);
    const handle = createMantleRequestHandler(options);
    const response = await handle(new Request("https://site.test/api/items", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    }));
    expect(response!.status).toBe(413);
    expect(await response!.json()).toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
    expect(options.invokeTrigger).not.toHaveBeenCalled();
  });
  it.each([1, 10, 100, 1000])("performs constant segment lookups among %i literal-prefix routes", async (count) => {
    const options = fixture(Array.from({ length: count }, (_, i) => `/api/r${String(i).padStart(4, "0")}/{id}`));
    const match = paths.compileRouteMatcher(options.plan.httpRoutes);
    const lookups = vi.spyOn(Map.prototype, "get");
    const path = `/api/r${String(count - 1).padStart(4, "0")}/one%20two`;
    expect(match(path)).toMatchObject({ route: { trigger: `route-${count - 1}` }, params: { id: "one two" } });
    expect(lookups).toHaveBeenCalledTimes(4);
    lookups.mockRestore();
    const handle = createMantleRequestHandler(options);
    expect(await (await handle(request(path)))!.json()).toEqual({ ok: true, data: { trigger: `route-${count - 1}`, id: "one two" } });
  });

  it("preserves decoding, method misses, body precedence, overlap priority and diagnostics", async () => {
    const options = fixture(["/api/items/{id}", "/api/items/literal"]);
    const handle = createMantleRequestHandler(options);
    for (const path of ["/api/items/literal", "/api/items/litera%6c", "/api/items/literal/"]) {
      expect(await (await handle(request(path)))!.json()).toMatchObject({ data: { trigger: "route-1" } });
    }
    expect(await handle(request("/api/items/x", "GET"))).toBeNull();
    expect(await handle(request("/api/items/%GG"))).toBeNull();
    expect(await (await handle(request("/api/it%65ms/a%20b/")))!.json()).toMatchObject({ data: { id: "a b" } });
    expect(await (await handle(request("/api/items/a%2Fb")))!.json()).toMatchObject({ data: { id: "a/b" } });
    const badBody = await handle(new Request("https://site.test/api/items/x", {
      method: "POST", headers: { "content-type": "application/json" }, body: "[]",
    }));
    expect(badBody!.status).toBe(400);
    expect(await badBody!.json()).toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED", path: "POST /api/items/{id}#/body" } });
  });

  it("matches the original ordered matcher for overlapping wildcard shapes", () => {
    const routes = ["/api/x/{v}/deep", "/api/{a}/{b}", "/api/x/{z}", "/api/{left}/fixed", "/api/x/{right}", "/api/{a}/{b}", "/api/x/fixed", "/api/end"]
      .map((path) => ({ path }));
    for (const ordered of [routes, [...routes].reverse()]) {
      const match = paths.compileRouteMatcher(ordered);
      for (const path of ["/api/x/fixed", "/api/x/f%69xed", "/api/y/z", "/api/x/no", "/api/end/", "/api/%GG/z", "/api/end/extra"]) {
        const expected = ordered.map((route) => ({ route, params: paths.matchPath(route.path, path) }))
          .find(({ params }) => params !== null) ?? null;
        expect(match(path)).toEqual(expected);
      }
    }
  });
});
