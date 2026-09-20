import type { AdminAssetServer } from "@aotter/mantle-admin";
import type { MantleCloudflareConfig } from "../mount/cmsConfig.js";
import { AssetsAssetServer } from "./AssetsAssetServer.js";
import { D1DatabaseDriver } from "./D1DatabaseDriver.js";

// Pre-static-assets starters remain runnable during the alpha migration;
// their Admin route returns the explicit missing-assets response.
const NO_ASSETS: AdminAssetServer = { fetch: async () => null };

export interface ConventionalBindingsEnv {
  readonly DB?: D1Database;
  readonly ASSETS?: Fetcher;
  /** Optional app/environment-owned KV namespace for MCP catalog settings. */
  readonly MANTLE_KV?: KVNamespace;
}

export type MantleWorkerBindings = MantleCloudflareConfig["bindings"];

/** Bind the conventional Cloudflare names to Mantle's existing runtime adapters. */
export function createConventionalBindings(
  env: ConventionalBindingsEnv,
  cacheScope?: string,
): MantleWorkerBindings {
  if (!env.DB) throw new Error("Mantle requires the conventional DB binding.");
  return {
    db: new D1DatabaseDriver(env.DB),
    adminAssets: env.ASSETS ? new AssetsAssetServer(env.ASSETS) : NO_ASSETS,
    ...(env.MANTLE_KV && cacheScope
      ? { mcpCatalogKv: { namespace: env.MANTLE_KV, scope: cacheScope } }
      : {}),
  };
}
