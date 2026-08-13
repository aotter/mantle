import { describe, expect, it } from "vitest";
import {
  AssetsAssetServer,
  D1DatabaseDriver,
  createConventionalBindings,
  type ConventionalBindingsEnv,
} from "../src/bindings/index.js";

const DB = {} as D1Database;
const OAUTH_KV = {} as KVNamespace;

describe("createConventionalBindings", () => {
  it("reuses the existing adapters for conventional bindings", () => {
    const ASSETS = { fetch: async () => new Response("asset") } as Fetcher;
    const bindings = createConventionalBindings({ DB, OAUTH_KV, ASSETS });

    expect(bindings.db).toBeInstanceOf(D1DatabaseDriver);
    expect(bindings.assets).toBeInstanceOf(AssetsAssetServer);
  });

  it.each(["DB", "OAUTH_KV", "ASSETS"] as const)("names a missing %s binding", (name) => {
    const env: ConventionalBindingsEnv = {
      DB,
      OAUTH_KV,
      ASSETS: { fetch: async () => new Response("asset") } as Fetcher,
    };
    const missing = { ...env, [name]: undefined };

    expect(() => createConventionalBindings(missing)).toThrow(name);
  });

});
