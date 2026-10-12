import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import ts from 'typescript';
import { generateOrThrow, writeGenerated } from './apps/link.js';
const example = resolve(import.meta.dir, '../../../docs/examples/generated-web');
const sources = async () => [{ sourceId: 'posts.yaml', text: await readFile(join(example, 'posts.yaml'), 'utf8') }];
async function writeWorker(dir: string) {
  await mkdir(join(dir, 'src')); const entry = join(dir, 'src/worker.ts');
  await writeFile(entry, await readFile(join(example, 'src/worker.ts'), 'utf8')); return entry;
}

test('documented web Worker serves SQL-visible HTML, REST, indexes and alternates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mantle-web-example-')), db = new Database(':memory:');
  try {
    const files = await generateOrThrow('bun-sqlite', await sources()); await writeGenerated(join(dir, 'generated'), files);
    const worker = (await import(await writeWorker(dir))).default;
    db.exec(files['schema.sql']!); db.exec(await readFile(join(example, 'seed.sql'), 'utf8'));
    const env = { DB: db, PUBLIC_ORIGIN: 'https://public.test' };
    const get = (path: string, method = 'GET') => worker.fetch(new Request('https://other.test' + path, { method }), env);
    const index = await (await get('/')).text();
    expect(index).toContain('href="/posts/hello"'); expect(index).not.toContain('Hidden draft');
    expect(index).toContain('rel="canonical" href="https://public.test/"');
    expect(index).toContain('type="text/markdown" href="https://public.test/.md"');
    expect(await (await get('/.md')).text()).toContain('# Posts');
    const html = await (await get('/posts/hello')).text();
    expect(html).toContain('Hello &lt;world&gt;'); expect(html).not.toContain('Hello <world>');
    expect(html).toContain('rel="canonical" href="https://public.test/posts/hello"');
    expect(html).toContain('type="text/markdown" href="https://public.test/posts/hello.md"');
    expect(await (await get('/posts/hello.md')).text()).toBe('# Hello world');
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const result = await (await get('/api/views/posts?limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))).json();
      ids.push(...result.rows.map((row: { id: string }) => row.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['hello', 'second']);
    const llms = await (await get('/llms.txt')).text(), sitemap = await (await get('/sitemap.xml')).text();
    expect(llms.match(/^- /gm)).toHaveLength(ids.length); expect(sitemap.match(/<url>/g)).toHaveLength(ids.length);
    for (const id of ids) {
      expect(llms).toContain('https://public.test/posts/' + id); expect(sitemap).toContain('<loc>https://public.test/posts/' + id + '</loc>');
      expect((await get('/posts/' + id + '.md')).status).toBe(200);
    }
    for (const path of ['/posts/draft', '/posts/draft.md', '/missing']) {
      const response = await get(path); expect(response.status).toBe(404); expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(await (await get('/posts/hello', 'HEAD')).text()).toBe('');
    expect((await get('/posts/%xx')).status).toBe(400); expect((await get('/', 'POST')).headers.get('allow')).toBe('GET, HEAD');
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the exact example typechecks and bundles for D1', async () => {
  const parent = join(import.meta.dir, 'apps/.generated'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'web-example-d1-'));
  try {
    await writeGenerated(join(dir, 'generated'), await generateOrThrow('cloudflare-d1', await sources()), false);
    const entry = await writeWorker(dir);
    const program = ts.createProgram([entry], { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ['@cloudflare/workers-types'] });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, platform: 'neutral', format: 'esm', target: 'es2022' });
    expect(Object.keys(bundle.metafile!.inputs).some(path => /\/core\/|\/spec\//.test(path))).toBe(false);
    expect(Object.keys(bundle.metafile!.inputs).some(path => /\/mcp\.ts$|better-auth/.test(path))).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);
