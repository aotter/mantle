import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import ts from "typescript";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
const example = resolve(import.meta.dir, "../../../docs/examples/generated-web");
const sources = async () => [{ sourceId: "posts.yaml", text: await readFile(join(example, "posts.yaml"), "utf8") }];
async function writeWorker(dir: string) {
  await mkdir(join(dir, "src"));
  const entry = join(dir, "src/worker.ts");
  await cp(join(example, "src/worker.ts"), entry);
  // Before package assembly, resolve the public import to its existing kernel.
  const code = (await readFile(join(example, "src/app.ts"), "utf8")).replace(
    '"@aotter/mantle/contracts"',
    JSON.stringify(resolve(import.meta.dir, "../src/kernel/contracts.js")),
  );
  await writeFile(join(dir, "src/app.ts"), code);
  return entry;
}

test("documented Bun server serves SQL-visible HTML, REST, indexes and alternates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mantle-web-example-")),
    db = new Database(":memory:");
  const servers: { stop(closeActiveConnections?: boolean): void }[] = [];
  try {
    const files = await generateOrThrow("bun-sqlite", await sources());
    await writeGenerated(join(dir, "generated"), files);
    await writeWorker(dir);
    await cp(join(example, "bun"), join(dir, "bun"), { recursive: true });
    await cp(join(example, "public"), join(dir, "public"), { recursive: true });
    const { startBun } = await import(join(dir, "bun/server.ts"));
    db.exec(files["schema.sql"]!);
    db.exec(await readFile(join(example, "seed.sql"), "utf8"));
    let queries = 0;
    const env = {
      DB: {
        query: (sql: string) => {
          queries++;
          return db.query(sql);
        },
        exec: db.exec.bind(db),
        transaction: db.transaction.bind(db),
      },
      PUBLIC_ORIGIN: "https://public.test",
    };
    const native = startBun(env, { port: 0 });
    servers.push(native);
    const fallback = startBun(env, { port: 0, fetchOnly: true });
    servers.push(fallback);
    for (const server of [native, fallback]) {
      for (const method of ["GET", "HEAD"]) {
        const health = await fetch(new URL("/health", server.url), { method });
        expect(health.status).toBe(200);
        expect(health.headers.get("cache-control")).toBe("no-store");
        expect(await health.text()).toBe(method === "GET" ? "ok\n" : "");
        const asset = await fetch(new URL("/assets/posts.svg", server.url), { method });
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toBe("image/svg+xml");
        expect(asset.headers.get("cache-control")).toBe("no-cache");
        expect(await asset.text()).toBe(
          method === "GET" ? await readFile(join(example, "public/assets/posts.svg"), "utf8") : "",
        );
      }
    }
    expect(queries).toBe(0);
    const get = (path: string, method = "GET") => fetch(new URL(path, native.url), { method });
    const index = await (await get("/")).text();
    expect(queries).toBe(2);
    expect(index).toContain('href="/posts/hello"');
    expect(index).not.toContain("Hidden draft");
    expect(index).toContain('rel="canonical" href="https://public.test/"');
    expect(index).toContain('type="text/markdown" href="https://public.test/.md"');
    expect(await (await get("/.md")).text()).toContain("# Posts");
    queries = 0;
    const html = await (await get("/posts/hello")).text();
    expect(queries).toBe(2);
    expect(html).toContain("Hello &lt;world&gt;");
    expect(html).not.toContain("Hello <world>");
    expect(html).toContain('rel="canonical" href="https://public.test/posts/hello"');
    expect(html).toContain('type="text/markdown" href="https://public.test/posts/hello.md"');
    expect(await (await get("/posts/hello.md")).text()).toBe("# Hello world");
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = (await (
        await get("/api/views/posts?limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""))
      ).json()) as { rows: { id: string }[]; nextCursor: string | null };
      ids.push(...result.rows.map(row => row.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(["hello", "second"]);
    const llms = await (await get("/llms.txt")).text(),
      sitemap = await (await get("/sitemap.xml")).text();
    expect(llms.match(/^- /gm)).toHaveLength(ids.length);
    expect(sitemap.match(/<url>/g)).toHaveLength(ids.length + 1);
    expect(sitemap).toContain("<url><loc>https://public.test/</loc></url>");
    for (const id of ids) {
      expect(llms).toContain("https://public.test/posts/" + id);
      expect(sitemap).toContain("<loc>https://public.test/posts/" + id + "</loc>");
      expect((await get("/posts/" + id + ".md")).status).toBe(200);
    }
    for (const path of ["/posts/draft", "/posts/draft.md", "/missing"]) {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(await (await get("/posts/hello", "HEAD")).text()).toBe("");
    for (const cursor of ["broken", encodeURIComponent(JSON.stringify(["hello", "hello", "views/post"]))]) {
      const response = await get("/?cursor=" + encodeURIComponent(cursor));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toMatchObject({ error: { code: "INPUT_VALIDATION_FAILED" } });
    }
    for (const [path, status] of [
      ["/posts/%xx", 400],
      ["/posts/%E0%A4%A", 400],
      ["/posts/2026-02-30", 404],
      ["/posts/2026-02-30.md", 404],
    ] as const) {
      const response = await get(path);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect((await get("/posts/%xx")).status).toBe(400);
    expect((await get("/", "POST")).headers.get("allow")).toBe("GET, HEAD");
  } finally {
    for (const server of servers) server.stop(true);
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the exact example typechecks and bundles for D1", async () => {
  const parent = join(import.meta.dir, "apps/.generated");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "web-example-d1-"));
  try {
    await writeGenerated(join(dir, "generated"), await generateOrThrow("cloudflare-d1", await sources()), false);
    const entry = await writeWorker(dir);
    const program = ts.createProgram([entry], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ["@cloudflare/workers-types"],
    });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual(
      [],
    );
    const bundle = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      platform: "neutral",
      format: "esm",
      target: "es2022",
    });
    expect(Object.keys(bundle.metafile!.inputs).some(path => /\/core\/|\/spec\//.test(path))).toBe(false);
    expect(Object.keys(bundle.metafile!.inputs).some(path => /\/mcp\.ts$|better-auth/.test(path))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
