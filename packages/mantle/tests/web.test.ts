import { fixtureCaller } from "./apps/fixtures.js";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { generateOrThrow, writeGenerated } from "./apps/link.js";

const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
  title: Posts
  lifecycle: operational
  schema:
    type: object
    required: [slug, title, body, visible]
    properties:
      slug: {type: string}
      title: {type: string}
      body: {type: [string, "null"]}
      visible: {type: boolean}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: posts}
spec:
  surface: public
  sql: SELECT id, slug, title, updated_at FROM posts WHERE visible = true ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: post-by-slug}
spec:
  surface: public
  input:
    type: object
    required: [slug]
    additionalProperties: false
    properties: {slug: {type: string, minLength: 2}}
  sql: SELECT id, slug, body FROM posts WHERE slug = input.slug AND visible = true ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: by-visible}
spec:
  surface: public
  input:
    type: object
    required: [visible]
    additionalProperties: false
    properties: {visible: {type: boolean}}
  sql: SELECT id, slug, body, visible FROM posts WHERE visible = input.visible ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: posts-matching}
spec:
  surface: public
  input:
    type: object
    additionalProperties: false
    properties: {slug: {type: string}, title: {type: string}}
    anyOf: [{required: [slug]}, {required: [title]}]
  sql: SELECT id, slug, title FROM posts WHERE slug = input.slug OR title = input.title ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: private-posts}
spec:
  surface: internal
  sql: SELECT id FROM posts ORDER BY id
`;

test("dynamic web output trusts SQL visibility, escapes output and revalidates content", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "blog.yaml", text: source }]);
  const dir = await mkdtemp(join(tmpdir(), "mantle-web-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    for (let i = 0; i < 7; i++)
      db.query(
        "INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) VALUES (?,1,0,0,?,?,?,?)",
      ).run(String(i), i === 1 ? "a&b)" : "post" + i, "Title [" + i + "]", "# body " + i, i === 0 ? 0 : 1);
    const { web } = await import(join(dir, "web.ts"));
    const site = web({
      db,
      caller: { kind: "anonymous" },
      origin: "https://site.test",
      title: "Blog",
      description: "Summary",
      locales: ["en"],
      pages: { "/posts/{slug}": { view: "post-by-slug", list: "posts", markdown: "body" } },
    });
    expect(() =>
      web({
        db,
        caller: { kind: "anonymous" },
        origin: "https://site.test",
        title: "Blog",
        description: "Summary",
        pages: { "/posts/{slug}": { view: "post-by-slug", list: "posts-matching" } },
      }),
    ).toThrow(
      "Page /posts/{slug} lists View 'posts-matching', whose input rejects an empty query; a list View must accept no input.",
    );
    const request = (path: string, init?: RequestInit) => new Request("https://untrusted.test" + path, init);
    const llms = await site.fetch(request("/llms.txt")),
      text = await llms.text();
    expect(text).toContain("# Blog\n\n> Summary");
    expect(text.match(/^- /gm)).toHaveLength(6);
    expect(text).not.toContain("post0");
    expect(text).toContain("Title \\[1\\]");
    // The list View does not select `body`: llms.txt links the Markdown alternate of a page that declares one.
    expect(text).toContain("(https://site.test/posts/a%26b%29.md)");
    const sitemap = await site.fetch(request("/sitemap.xml"));
    expect((await sitemap.text()).match(/<url>/g)).toHaveLength(6);
    const md = await site.fetch(request("/posts/a%26b).md"));
    expect(await md.text()).toBe("# body 1");
    expect(md.headers.get("cache-control")).toBe("public, max-age=60");
    for (const response of [llms, sitemap, md]) expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await site.fetch(request("/posts/post0.md"))).status).toBe(404);
    expect(await site.head(request("/posts/post0"))).toBe("");
    const tags = await site.head(request("/posts/a%26b)"));
    expect(tags).toContain('rel="canonical" href="https://site.test/posts/a%26b%29"');
    expect(tags).toContain('type="text/markdown"');
    expect(tags).toContain('hreflang="en"');
    const etag = md.headers.get("etag");
    expect((await site.fetch(request("/posts/a%26b).md", { headers: { "if-none-match": "W/" + etag } }))).status).toBe(
      304,
    );
    db.query("UPDATE posts SET body='changed' WHERE id='1'").run();
    const changed = await site.fetch(request("/posts/a%26b).md", { headers: { "if-none-match": etag } }));
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect((await site.fetch(request("/posts/%xx.md"))).status).toBe(400);
    expect(await site.head(request("/posts/%xx"))).toBe("");
    expect(await site.head(request("/posts/x"))).toBe("");
    expect(await site.head(request("/posts/%61%26b)"))).toBe(await site.head(request("/posts/a&b)")));
    let resolved = 0;
    const dynamic = web({
      db,
      caller: (req: Request, env: { admin: boolean }) => {
        resolved++;
        return env.admin
          ? fixtureCaller({
              kind: "user",
              subject: "s",
              role: "editor",
              scopes: [],
              credential: "session",
              credentialId: null,
              clientId: null,
            })
          : { kind: "anonymous" };
      },
      origin: "https://site.test",
      title: "Blog",
      description: "x",
      pages: { "/posts/{slug}": { view: "post-by-slug", markdown: "body" } },
    });
    expect((await dynamic.fetch(request("/posts/a%26b).md"), { admin: true })).headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(resolved).toBe(1);
    db.query(
      "INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) VALUES ('md',1,0,0,'readme.md','Readme','# Readme',1)",
    ).run();
    expect(await site.fetch(request("/posts/readme.md"))).toBeUndefined();
    expect(await (await site.fetch(request("/posts/readme.md.md"))).text()).toBe("# Readme");
    db.query(
      "INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) VALUES ('null',1,0,0,'null','Null',NULL,1)",
    ).run();
    const nullMd = await site.fetch(request("/posts/null.md"));
    expect(nullMd.status).toBe(404);
    expect(nullMd.headers.get("cache-control")).toBe("no-store");
    const booleans = web({
      db,
      caller: { kind: "anonymous" },
      origin: "https://site.test",
      title: "x",
      description: "y",
      pages: { "/visibility/{visible}": { view: "by-visible", markdown: "body" } },
    });
    expect(await (await booleans.fetch(request("/visibility/true.md"))).text()).toBe("changed");
    expect((await booleans.fetch(request("/visibility/notbool.md"))).status).toBe(400);
    expect(await site.fetch(request("/unknown.md"))).toBeUndefined();
    expect(await site.fetch(request("/posts/a%26b)"))).toBeUndefined();
    expect(await site.fetch(request("/llms.txt", { method: "POST" }))).toBeUndefined();
    expect(await (await site.fetch(request("/llms.txt", { method: "HEAD" }))).text()).toBe("");
    const multilingual = web({
      db,
      caller: { kind: "anonymous" },
      origin: "https://site.test",
      title: "x",
      description: "y",
      locales: ["en", "zh"],
      pages: { "/posts/{slug}": { view: "post-by-slug", markdown: "body" } },
    });
    // One locale's hreflang on every translation would mislabel them, so several locales emit none.
    expect(await multilingual.head(request("/posts/a%26b)"))).not.toContain("hreflang");
    // Given the row the application already read, head reads no View: post0 is hidden from the View.
    const hidden = { id: "0", slug: "post0", body: "# body 0" };
    expect(await site.head(request("/posts/post0"), undefined, undefined, { row: hidden })).toContain(
      'rel="canonical" href="https://site.test/posts/post0"',
    );
    const refusing = web({
      db,
      caller: { kind: "anonymous" },
      authorize: () => false,
      origin: "https://site.test",
      title: "x",
      description: "y",
      pages: { "/posts/{slug}": { view: "post-by-slug", markdown: "body" } },
    });
    await expect(refusing.head(request("/posts/a%26b)"))).rejects.toThrow();
    expect(await refusing.head(request("/posts/post0"), undefined, undefined, { row: hidden })).toContain(
      'href="https://site.test/posts/post0.md"',
    );
    // `page` without a row (the application's read found none) is no tags, not a read or a refusal of its own.
    const none = { row: undefined } as unknown as { row: Record<string, unknown> };
    expect(await refusing.head(request("/posts/a%26b)"), undefined, undefined, none)).toBe("");
    expect(await site.head(request("/posts/a%26b)"), undefined, undefined, none)).toBe("");
    // A row without Markdown has no alternate to name: `<url>.md` answers 404.
    expect(
      await site.head(request("/posts/post0"), undefined, undefined, { row: { ...hidden, body: null } }),
    ).not.toContain("text/markdown");
    db.query("UPDATE posts SET updated_at = 1767225600000000 WHERE id = '2'").run();
    const dated = web({
      db,
      caller: { kind: "anonymous" },
      origin: "https://site.test",
      title: "x",
      description: "y",
      sitemap: ["/", "/posts"],
      pages: { "/posts/{slug}": { view: "post-by-slug", list: "posts", lastmod: "updated_at" } },
    });
    const datedXml = await (await dated.fetch(request("/sitemap.xml"))).text();
    expect(datedXml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://site.test/</loc></url><url><loc>https://site.test/posts</loc></url><url>',
    );
    expect(datedXml).toContain(
      "<url><loc>https://site.test/posts/post2</loc><lastmod>2026-01-01T00:00:00.000000Z</lastmod></url>",
    );
    expect(datedXml.match(/<url>/g)).toHaveLength(2 + 8);
    expect(await (await dated.fetch(request("/llms.txt"))).text()).not.toContain("https://site.test/posts)");
    for (const path of ["posts", "/posts?x", "/posts#x", "/posts/{slug}"])
      expect(() =>
        web({ db, origin: "https://site.test", title: "x", description: "y", sitemap: [path], pages: {} }),
      ).toThrow("Page templates and sitemap paths must be absolute paths without queries or fragments.");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web indexes preserve an authored total LIMIT rather than treating it as a page size", async () => {
  const limited = source.replace(
    "FROM posts WHERE visible = true ORDER BY id",
    "FROM posts WHERE visible = true ORDER BY id LIMIT 3",
  );
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "limited-blog.yaml", text: limited }]);
  const dir = await mkdtemp(join(tmpdir(), "mantle-web-limit-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    for (let i = 0; i < 7; i++)
      db.query(
        "INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) VALUES (?,1,0,0,?,?,?,?)",
      ).run(String(i), "post" + i, "Title " + i, "body", i === 0 ? 0 : 1);
    const { web } = await import(join(dir, "web.ts"));
    const site = web({
      db,
      caller: { kind: "anonymous" },
      origin: "https://site.test",
      title: "Blog",
      description: "x",
      pages: { "/posts/{slug}": { view: "post-by-slug", list: "posts", markdown: "body" } },
    });
    const sitemap = await (await site.fetch(new Request("https://site.test/sitemap.xml"))).text();
    expect(sitemap.match(/<url>/g)).toHaveLength(3);
    expect([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1])).toEqual(
      [1, 2, 3].map(i => "https://site.test/posts/post" + i),
    );
    const llms = await (await site.fetch(new Request("https://site.test/llms.txt"))).text();
    expect(llms.match(/^- /gm)).toHaveLength(3);
    expect(llms).not.toContain("/post4");
    expect(llms).not.toContain("/post0");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const composedDoc = `---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: doc-by-slug}
spec:
  surface: public
  input:
    type: object
    required: [slug]
    additionalProperties: false
    properties: {slug: {type: string, minLength: 2}}
  sql: SELECT id, slug, title || E'\\n\\n' || coalesce(body, '') AS doc, lower(title) AS shout FROM posts WHERE slug = input.slug AND visible = true ORDER BY id
`;

test("public View and exact URL input names are typechecked on every target", async () => {
  await mkdir(join(import.meta.dir, "apps/.generated/"), { recursive: true });
  const dir = await mkdtemp(join(import.meta.dir, "apps/.generated/", "web-types-"));
  try {
    const roots: string[] = [];
    for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) {
      const destination = join(dir, target);
      await writeGenerated(
        destination,
        await generateOrThrow(target, [{ sourceId: "blog.yaml", text: source + composedDoc }]),
        false,
      );
      const check = join(destination, "check.ts");
      await writeFile(
        check,
        `import {web} from './web.js';
import {rest} from './rest.js';
import {mcp} from './mcp.js';
const base={db:null as any,caller:{kind:'anonymous'} as const,origin:'https://site.test',title:'Blog',description:'Summary'};
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',list:'posts',markdown:'body'}}});
// @ts-expect-error unknown view
web({...base,pages:{'/posts/{slug}':{view:'missing'}}});
// @ts-expect-error internal view
web({...base,pages:{'/posts':{view:'private-posts'}}});
// @ts-expect-error wrong param
web({...base,pages:{'/posts/{id}':{view:'post-by-slug'}}});
// @ts-expect-error missing param
web({...base,pages:{'/posts':{view:'post-by-slug'}}});
// @ts-expect-error extra param
web({...base,pages:{'/posts/{slug}/{id}':{view:'post-by-slug'}}});
// @ts-expect-error list needs inputs
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',list:'post-by-slug'}}});
// @ts-expect-error a list View's input rules reject an empty query
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',list:'posts-matching'}}});
// @ts-expect-error unknown markdown column
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',markdown:'unknown'}}});
// text composed in SQL (#2091) is a Markdown column; another computed column is not text
web({...base,pages:{'/docs/{slug}':{view:'doc-by-slug',list:'posts',markdown:'doc'}}});
// @ts-expect-error a computed output that is not composed text is unknown
web({...base,pages:{'/docs/{slug}':{view:'doc-by-slug',markdown:'shout'}}});
const dated=web({...base,sitemap:['/'],pages:{'/posts/{slug}':{view:'post-by-slug',list:'posts',lastmod:'updated_at'}}});
// @ts-expect-error lastmod names a column of the list View
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',list:'posts',lastmod:'body'}}});
// @ts-expect-error lastmod needs a list
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',lastmod:'updated_at'}}});
dated.head(new Request('https://site.test/posts/a'),undefined,undefined,{row:{id:'a',slug:'a',body:null}});
// @ts-expect-error the row is a row of a page's View
dated.head(new Request('https://site.test/posts/a'),undefined,undefined,{row:{slug:1}});
// @ts-expect-error a generated entry supplies the manifest's user fields itself
web({...base,fields:{},pages:{'/posts':{view:'posts'}}});
// @ts-expect-error a generated entry supplies the manifest's user fields itself
rest({db:()=>null as any,fields:{}});
// @ts-expect-error a generated entry supplies the manifest's user fields itself
mcp({db:()=>null as any,handlers:{},fields:{}});
`,
      );
      roots.push(check);
    }
    const program = ts.createProgram(roots, {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ["bun-types"],
      typeRoots: [join(import.meta.dir, "../node_modules/@types"), join(import.meta.dir, "../node_modules")],
      allowImportingTsExtensions: true,
    });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual(
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("publishing SQL keeps drafts out of all web outputs", async () => {
  const { generateFromSources } = await import("../src/infrastructure/generate.js");
  const result = await generateFromSources({
    target: "bun-sqlite",
    sources: {
      sources: [
        { sourceId: "publishing-blog.yaml", text: source.replace("lifecycle: operational", "lifecycle: publishing") },
      ],
    },
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  const dir = await mkdtemp(join(tmpdir(), "mantle-web-publishing-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, result.files);
    db.exec(result.files["schema.sql"]!);
    for (const [id, status] of [
      ["draft", "draft"],
      ["public", "published"],
    ] as const)
      db.query(
        "INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible,status) VALUES (?,1,0,0,?,?,?,1,?)",
      ).run(id, id, id, "# " + id, status);
    const { web } = await import(join(dir, "web.ts"));
    for (const caller of [
      { kind: "anonymous" },
      fixtureCaller({
        kind: "user",
        subject: "editor",
        role: "editor",
        scopes: [],
        credential: "session",
        credentialId: null,
        clientId: null,
      }),
    ]) {
      const site = web({
        db,
        caller,
        origin: "https://site.test",
        title: "Blog",
        description: "Summary",
        pages: { "/posts/{slug}": { view: "post-by-slug", list: "posts", markdown: "body" } },
      });
      for (const path of ["/llms.txt", "/sitemap.xml"]) {
        const response = await site.fetch(new Request("https://site.test" + path));
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain("public");
        expect(body).not.toContain("draft");
      }
      expect((await site.fetch(new Request("https://site.test/posts/draft.md"))).status).toBe(404);
      expect(await site.head(new Request("https://site.test/posts/draft"))).toBe("");
      expect(await (await site.fetch(new Request("https://site.test/posts/public.md"))).text()).toBe("# public");
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web indexes bound row scans and real cursor queries", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "big-blog.yaml", text: source }]);
  const dir = await mkdtemp(join(tmpdir(), "mantle-web-cap-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    const insert = db.query(
      "INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) VALUES (?,1,0,0,?,?,?,1)",
    );
    db.transaction(() => {
      for (let i = 0; i < 50504; i++) insert.run(String(i).padStart(5, "0"), "post" + i, "Title " + i, "# body");
    })();
    let queries = 0;
    const handle = {
      query(sql: string) {
        queries++;
        return db.query(sql);
      },
      exec: db.exec.bind(db),
      transaction: db.transaction.bind(db),
    };
    const { web } = await import(join(dir, "web.ts"));
    const site = web({
      db: handle,
      caller: { kind: "anonymous" },
      origin: "https://site.test",
      title: "Blog",
      description: "x",
      pages: { "/posts/{slug}": { view: "post-by-slug", list: "posts", markdown: "body" } },
    });
    const sitemap = await site.fetch(new Request("https://site.test/sitemap.xml"));
    expect(sitemap.status).toBe(200);
    expect((await sitemap.text()).match(/<url>/g)).toHaveLength(50000);
    expect(queries).toBe(100);
    queries = 0;
    const llms = await site.fetch(new Request("https://site.test/llms.txt"));
    expect((await llms.text()).match(/^- /gm)).toHaveLength(5000);
    expect(queries).toBe(10);
    // An unbounded View with an explicit one-row paging option exercises the query-count ceiling,
    // independently of authored SQL LIMIT (which bounds the entire result set).
    const { web: nativeWeb } = await import("../src/kernel/web.js");
    const { default: postsPage } = await import(join(dir, "paged/views/posts.ts"));
    const { default: postPage } = await import(join(dir, "paged/views/post-by-slug.ts"));
    const one = nativeWeb(
      {
        db: handle,
        caller: { kind: "anonymous" },
        origin: "https://site.test",
        title: "x",
        description: "y",
        pages: { "/posts/{slug}": { view: "post-by-slug", list: "posts", markdown: "body" } },
      },
      [
        [
          "posts",
          {
            query: () => ({ input: {} }),
            page: (db, caller, input, paging) => postsPage(db, caller, input, { ...paging, limit: 1 }),
          },
        ],
        ["post-by-slug", { query: params => ({ input: { slug: params.get("slug") } }), page: postPage }],
      ],
    );
    queries = 0;
    expect(
      (await (await one.fetch(new Request("https://site.test/sitemap.xml")))!.text()).match(/<url>/g),
    ).toHaveLength(100);
    expect(queries).toBe(100);
    queries = 0;
    expect((await (await one.fetch(new Request("https://site.test/llms.txt")))!.text()).match(/^- /gm)).toHaveLength(
      10,
    );
    expect(queries).toBe(10);
    db.query("UPDATE posts SET slug='.' WHERE id='00000'").run();
    db.query("UPDATE posts SET slug='..' WHERE id='00001'").run();
    queries = 0;
    const skip = await (await site.fetch(new Request("https://site.test/llms.txt"))).text();
    expect(skip).not.toContain("https://site.test/posts/.)");
    expect(skip).not.toContain("https://site.test/posts/..)");
    expect(skip.match(/^- /gm)).toHaveLength(4998);
    expect(queries).toBe(10);
    db.query("UPDATE posts SET title=? WHERE id='00002'").run("x".repeat(1024 * 1024));
    queries = 0;
    const bounded = await (await site.fetch(new Request("https://site.test/llms.txt"))).text();
    expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(1024 * 1024);
    expect(queries).toBe(1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test.skipIf(!process.env.MANTLE_NEXT_BUN_PG_URL)(
  "Bun.SQL web uses real PostgreSQL cursor pages and current Markdown",
  async () => {
    const { SQL } = await import("bun");
    const schema = "web_" + crypto.randomUUID().replaceAll("-", "");
    const admin = new SQL({ url: process.env.MANTLE_NEXT_BUN_PG_URL!, max: 1 });
    await admin.unsafe('CREATE SCHEMA "' + schema + '"', []);
    const db = new SQL({ url: process.env.MANTLE_NEXT_BUN_PG_URL!, max: 1, connection: { search_path: schema } }),
      dir = await mkdtemp(join(tmpdir(), "mantle-web-pg-"));
    try {
      const files = await generateOrThrow("bun-postgres", [{ sourceId: "pg-blog.yaml", text: source }]);
      await writeGenerated(dir, files);
      await db.unsafe(files["schema.sql"]!, []);
      await db.unsafe(
        "INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) SELECT lpad(i::text,4,'0'),1,now(),now(),'post'||i,'Title '||i,'# body '||i,true FROM generate_series(0,1004) i",
        [],
      );
      const { web } = await import(join(dir, "web.ts"));
      let queries = 0;
      const handle = {
        unsafe: (sql: string, args: any[]) => {
          queries++;
          return db.unsafe(sql, args);
        },
        begin: db.begin.bind(db),
      };
      const site = web({
        db: handle,
        caller: { kind: "anonymous" },
        origin: "https://site.test",
        title: "PG",
        description: "x",
        pages: { "/posts/{slug}": { view: "post-by-slug", list: "posts", markdown: "body", lastmod: "updated_at" } },
      });
      const sitemap = await site.fetch(new Request("https://site.test/sitemap.xml"));
      expect(sitemap.status).toBe(200);
      const xml = await sitemap.text();
      expect(xml.match(/<url>/g)).toHaveLength(1005);
      // PostgreSQL timestamps reach the list row as the generated SQL's UTC text.
      expect(xml.match(/<lastmod>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z<\/lastmod>/g)).toHaveLength(1005);
      expect(queries).toBe(3);
      queries = 0;
      expect((await (await site.fetch(new Request("https://site.test/llms.txt"))).text()).match(/^- /gm)).toHaveLength(
        1005,
      );
      expect(queries).toBe(3);
      const md = await site.fetch(new Request("https://site.test/posts/post503.md"));
      expect(await md.text()).toBe("# body 503");
      const tags = await site.head(new Request("https://request.test/posts/%70ost503"));
      expect(tags).toContain('href="https://site.test/posts/post503"');
      const etag = md.headers.get("etag");
      await db.unsafe("UPDATE posts SET body='changed' WHERE slug='post503'", []);
      const changed = await site.fetch(
        new Request("https://site.test/posts/post503.md", { headers: { "if-none-match": etag } }),
      );
      expect(changed.status).toBe(200);
      expect(await changed.text()).toBe("changed");
    } finally {
      await db.close();
      await admin.unsafe('DROP SCHEMA "' + schema + '" CASCADE', []);
      await admin.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a Worker importing a View does not bundle optional web", async () => {
  const { build } = await import("esbuild");
  const files = await generateOrThrow("cloudflare-d1", [{ sourceId: "blog.yaml", text: source }]);
  const dir = await mkdtemp(join(tmpdir(), "mantle-web-tree-"));
  try {
    await writeGenerated(dir, files);
    const entry = join(dir, "worker.ts");
    await writeFile(
      entry,
      'import query from "./views/posts.js";export default {fetch:async (_request:Request,env:any)=>Response.json(await query(env.DB,{kind:"anonymous"},{}))};',
    );
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      platform: "neutral",
      format: "esm",
      target: "es2022",
    });
    expect(Object.keys(result.metafile!.inputs).some(name => name.endsWith("/web.ts"))).toBe(false);
    expect(result.outputFiles![0]!.text).not.toContain("llms.txt");
    expect(result.outputFiles![0]!.text).not.toContain("SHA-256");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("llms.txt links a page's Markdown alternate; the sitemap keeps the page URL", async () => {
  const { webIndex } = await import("../src/kernel/web-index.js");
  const rows = [{ slug: "a", body: "# a" }, { slug: "b", body: null }, { slug: "c" }];
  const pages = [
    { path: "/md/{slug}", page: { view: "one", list: "all", markdown: "body" } },
    { path: "/html/{slug}", page: { view: "one", list: "all" } },
  ];
  const index = (sitemap: boolean) =>
    webIndex(
      sitemap,
      { origin: "https://site.test", title: "T", description: "D" },
      pages,
      async () => ({ rows }),
      (path, row) => "https://site.test" + path.replace("{slug}", String(row.slug)),
    );
  const links = [...(await index(false)).matchAll(/\]\((.*?)\)/g)].map(match => match[1]);
  // A list row whose Markdown column is NULL has no alternate; a list that does not select the column links it.
  expect(links).toEqual([
    "https://site.test/md/a.md",
    "https://site.test/md/b",
    "https://site.test/md/c.md",
    "https://site.test/html/a",
    "https://site.test/html/b",
    "https://site.test/html/c",
  ]);
  expect(await index(true)).not.toContain(".md");
});

test("sitemap lastmod is a W3C datetime or absent; static paths share the scan cap", async () => {
  const { webIndex } = await import("../src/kernel/web-index.js");
  const at = [
    "2026-01-01",
    "2026-01-01T08:00:00.123456+08:00",
    "2026-13-45",
    "2026-02-30",
    "2026-02-30T00:00:00Z",
    "yesterday",
    null,
    1767225600,
    "1",
  ];
  const rows = at.map((value, i) => ({ slug: "p" + i, at: value }));
  const xml = await webIndex(
    true,
    { origin: "https://site.test", title: "T", description: "D", sitemap: ["/", "/café x"] },
    [{ path: "/p/{slug}", page: { view: "one", list: "all", lastmod: "at" } }],
    async () => ({ rows }),
    (path, row) => "https://site.test" + path.replace("{slug}", String(row.slug)),
  );
  expect([...xml.matchAll(/<lastmod>(.*?)<\/lastmod>/g)].map(match => match[1])).toEqual([
    "2026-01-01",
    "2026-01-01T08:00:00.123456+08:00",
  ]);
  expect(xml.match(/<url>/g)).toHaveLength(2 + at.length);
  // A static path is written as a URL, like the rows' own.
  expect(xml).toContain("<loc>https://site.test/caf%C3%A9%20x</loc>");
  const capped = await webIndex(
    true,
    {
      origin: "https://site.test",
      title: "T",
      description: "D",
      sitemap: Array.from({ length: 50001 }, (_, i) => "/" + i),
    },
    [{ path: "/p/{slug}", page: { view: "one", list: "all" } }],
    async () => {
      throw new Error("a full sitemap reads no list");
    },
    () => undefined,
  );
  expect(capped.match(/<url>/g)).toHaveLength(50000);
});
