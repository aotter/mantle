import { describe, expect, it } from "vitest";
import {
  AssetsAssetServer,
  D1DatabaseDriver,
  createConventionalBindings,
  type ConventionalBindingsEnv,
} from "../src/bindings/index.js";

const DB = {} as D1Database;

describe("createConventionalBindings", () => {
  it("reuses the existing adapters for conventional bindings", () => {
    const ASSETS = { fetch: async () => new Response("asset") } as Fetcher;
    const bindings = createConventionalBindings({ DB, ASSETS });

    expect(bindings.db).toBeInstanceOf(D1DatabaseDriver);
    expect(bindings.adminAssets).toBeInstanceOf(AssetsAssetServer);
  });

  it("names a missing DB binding", () => {
    const env: ConventionalBindingsEnv = {
      DB,
      ASSETS: { fetch: async () => new Response("asset") } as Fetcher,
    };
    const missing = { ...env, DB: undefined };

    expect(() => createConventionalBindings(missing)).toThrow("DB");
  });

  it("keeps pre-static-assets starters runnable without serving fake assets", async () => {
    const bindings = createConventionalBindings({ DB });
    await expect(bindings.adminAssets?.fetch(new Request("https://site.test/missing"))).resolves.toBeNull();
  });

  it("wires the conventional MANTLE_KV binding to an isolated catalog scope", () => {
    const MANTLE_KV = {} as KVNamespace;

    expect(createConventionalBindings({ DB, MANTLE_KV }, "site-prod").mcpCatalogKv).toEqual({
      namespace: MANTLE_KV,
      scope: "site-prod",
    });
    expect(createConventionalBindings({ DB, MANTLE_KV }).mcpCatalogKv).toBeUndefined();
    expect(createConventionalBindings({ DB }).mcpCatalogKv).toBeUndefined();
  });

});
