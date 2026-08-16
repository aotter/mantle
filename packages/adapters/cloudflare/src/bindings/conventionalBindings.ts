import type { AdminAssetServer } from "@aotter/mantle-admin";
import type { CmsConfig } from "../mount/cmsConfig.js";
import { AssetsAssetServer } from "./AssetsAssetServer.js";
import { D1DatabaseDriver } from "./D1DatabaseDriver.js";

// Pre-static-assets starters remain runnable during the alpha migration;
// their Admin route returns the explicit missing-assets response.
const NO_ASSETS: AdminAssetServer = { fetch: async () => null };

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
  return {
    db: new D1DatabaseDriver(env.DB),
    adminAssets: env.ASSETS ? new AssetsAssetServer(env.ASSETS) : NO_ASSETS,
  };
}
