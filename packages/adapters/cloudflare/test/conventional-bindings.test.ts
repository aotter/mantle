import { describe, expect, it } from "vitest";
import {
  AssetsAssetServer,
  D1DatabaseDriver,
  KvCacheBinding,
  createConventionalBindings,
  type ConventionalBindingsEnv,
} from "../src/bindings/index.js";

const DB = {} as D1Database;
const KV = {} as KVNamespace;
const OAUTH_KV = {} as KVNamespace;

describe("createConventionalBindings", () => {
  it("reuses the existing adapters for conventional bindings", () => {
    const ASSETS = { fetch: async () => new Response("asset") } as Fetcher;
    const bindings = createConventionalBindings({ DB, KV, OAUTH_KV, ASSETS });

    expect(bindings.db).toBeInstanceOf(D1DatabaseDriver);
    expect(bindings.kv).toBeInstanceOf(KvCacheBinding);
    expect(bindings.assets).toBeInstanceOf(AssetsAssetServer);
  });

  it.each(["DB", "KV", "OAUTH_KV"] as const)("names a missing %s binding", (name) => {
    const env: ConventionalBindingsEnv = { DB, KV, OAUTH_KV };
    const missing = { ...env, [name]: undefined };

    expect(() => createConventionalBindings(missing)).toThrow(name);
  });

  it("defines absent ASSETS as an empty asset server", async () => {
    const bindings = createConventionalBindings({ DB, KV, OAUTH_KV });

    await expect(bindings.assets.fetch(new Request("https://site.test/missing"))).resolves.toBeNull();
  });
});
