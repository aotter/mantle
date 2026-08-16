import type { AdminAssetServer } from "@aotter/mantle-admin";

/**
 * `AdminAssetServer` implementation wrapping Cloudflare's `ASSETS` binding (a
 * `Fetcher` that serves the worker's bundled static assets). Returns
 * the asset Response, or `null` when the asset is not found so the
 * Admin HTTP layer can fall back to the SPA's `index.html`
 * catchall (React Router model).
 */
export class AssetsAssetServer implements AdminAssetServer {
  constructor(private readonly assets: Fetcher) {}

  async fetch(req: Request): Promise<Response | null> {
    const res = await this.assets.fetch(req);
    if (res.status === 404) return null;
    return res;
  }
}
