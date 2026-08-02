import type { AssetServer } from "@aotter/mantle-runtime";
import type { CmsConfig } from "../mount/cmsConfig.js";
import { AssetsAssetServer } from "./AssetsAssetServer.js";
import { D1DatabaseDriver } from "./D1DatabaseDriver.js";
import { KvCacheBinding } from "./KvCacheBinding.js";

const NO_ASSETS: AssetServer = { fetch: async () => null };

export interface ConventionalBindingsEnv {
  readonly DB?: D1Database;
  readonly KV?: KVNamespace;
  readonly OAUTH_KV?: KVNamespace;
  readonly ASSETS?: Fetcher;
}

export type MantleWorkerBindings = CmsConfig["bindings"];

/** Bind the conventional Cloudflare names to Mantle's existing runtime adapters. */
export function createConventionalBindings(
  env: ConventionalBindingsEnv,
): MantleWorkerBindings {
  if (!env.DB) throw new Error("Mantle requires the conventional DB binding.");
  if (!env.KV) throw new Error("Mantle requires the conventional KV binding.");
  if (!env.OAUTH_KV) throw new Error("Mantle requires the conventional OAUTH_KV binding.");
  return {
    db: new D1DatabaseDriver(env.DB),
    kv: new KvCacheBinding(env.KV),
    assets: env.ASSETS ? new AssetsAssetServer(env.ASSETS) : NO_ASSETS,
  };
}
