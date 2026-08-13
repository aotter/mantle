/**
 * `AssetServer` — static-asset serving for the admin SPA. The admin
 * SPA itself lives in `@aotter/mantle-admin-ui` as a pre-built
 * `dist/` (commit 5); the adapter binds `AssetServer` to whatever
 * actually serves that `dist/`. The runtime knows nothing about MIME
 * types, caching headers, or compression — it just asks the port and
 * returns the response.
 *
 * CF adapter: wraps `env.ASSETS.fetch(req)`. Future: filesystem read,
 * S3+CDN, or another platform asset service.
 *
 * Returning `null` lets the runtime's HTTP layer fall back to the
 * SPA's `index.html` catchall — the React Router routing model.
 *
 * Renamed from `AssetsPort` per the clean-architecture naming
 * convention.
 */
export interface AssetServer {
  fetch(req: Request): Promise<Response | null>;
}
