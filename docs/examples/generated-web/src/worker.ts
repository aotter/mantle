import { store } from '../generated/generated.js';
import { rest } from '../generated/rest.js';
import { web } from '../generated/web.js';
import page from '../generated/paged/views/posts.js';

interface Env { DB: Parameters<typeof store>[0]; PUBLIC_ORIGIN: string }
const caller = { kind: 'anonymous' } as const;
const escape = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const segment = (text: string) => encodeURIComponent(text).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const site = web({ db: env.DB, caller, origin: env.PUBLIC_ORIGIN, title: 'Posts', description: 'A small public website',
      pages: { '/': { view: 'home', markdown: 'body' }, '/posts/{id}': { view: 'post', list: 'posts', markdown: 'body' } } });
    const api = await rest<Env>({ db: env => env.DB, caller: async () => caller })(request, env);
    if (api) return api;
    const output = await site.fetch(request, env);
    if (output) return output;
    const url = new URL(request.url), detail = /^\/posts\/([^/]+)$/.exec(url.pathname);
    if (url.pathname !== '/' && !detail) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
    let title = 'Posts', body: string;
    if (detail) {
      let id: string;
      try { id = decodeURIComponent(detail[1]!); } catch { return new Response('Invalid path', { status: 400, headers: { 'cache-control': 'no-store' } }); }
      // The Store applies publishing visibility in SQL. An anonymous caller cannot read a draft.
      const post = await store(env.DB, caller).collection('posts').findById(id);
      if (!post) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      title = post.title ?? 'Untitled';
      // Markdown stays plain text here; no untrusted HTML or Markdown renderer is needed.
      body = `<p><a href="/">All posts</a></p><pre>${escape(post.body ?? '')}</pre>`;
    } else {
      const result = await page(env.DB, caller, {}, { limit: 50, cursor: url.searchParams.get('cursor') ?? undefined });
      body = '<ul>' + result.rows.map(row => `<li><a href="/posts/${segment(String(row.id))}">${escape(row.title)}</a></li>`).join('') + '</ul>';
      if (result.nextCursor) body += `<a href="/?cursor=${encodeURIComponent(result.nextCursor)}">Next page</a>`;
    }
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>${await site.head(request, env)}</head><body><h1>${escape(title)}</h1>${body}</body></html>`;
    return new Response(request.method === 'HEAD' ? null : html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
};
