import type { CmsConfig } from "../mount/cmsConfig.js";
import { AssetsAssetServer } from "./AssetsAssetServer.js";
import { D1DatabaseDriver } from "./D1DatabaseDriver.js";

export interface ConventionalBindingsEnv {
  readonly DB?: D1Database;
  readonly OAUTH_KV?: KVNamespace;
  readonly ASSETS?: Fetcher;
}

export type MantleWorkerBindings = CmsConfig["bindings"];

/** Bind the conventional Cloudflare names to Mantle's existing runtime adapters. */
export function createConventionalBindings(
  env: ConventionalBindingsEnv,
): MantleWorkerBindings {
  if (!env.DB) throw new Error("Mantle requires the conventional DB binding.");
  if (!env.OAUTH_KV) throw new Error("Mantle requires the conventional OAUTH_KV binding.");
  if (!env.ASSETS) throw new Error("Mantle requires the conventional ASSETS binding.");
  return {
    db: new D1DatabaseDriver(env.DB),
    assets: new AssetsAssetServer(env.ASSETS),
  };
}
