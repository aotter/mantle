import { Database } from 'bun:sqlite';
import { fetchSite, health, type Env } from '../src/app.js';

const assetPath = '/assets/posts.svg';

export function startBun(env: Env, { port = 3000, fetchOnly = false } = {}) {
  const asset = Bun.file(new URL(`../public${assetPath}`, import.meta.url));
  const file = (method: 'GET' | 'HEAD') => new Response(method === 'GET' ? asset : null, {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }
  });

  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    development: false,
    routes: fetchOnly ? undefined : {
      '/health': { GET: health('GET'), HEAD: health('HEAD') },
      [assetPath]: { GET: file('GET'), HEAD: file('HEAD') }
    },
    fetch(request) {
      if (fetchOnly && (request.method === 'GET' || request.method === 'HEAD')) {
        const path = new URL(request.url).pathname;
        if (path === '/health') return health(request.method);
        if (path === assetPath) return file(request.method);
      }
      return fetchSite(request, env);
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const db = new Database(process.env.SQLITE_PATH ?? 'posts.sqlite', { readonly: true });
  const server = startBun({ DB: db, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}` }, {
    port,
    fetchOnly: process.argv.includes('--fetch-only')
  });
  console.log(`Listening at ${server.url}`);
}
