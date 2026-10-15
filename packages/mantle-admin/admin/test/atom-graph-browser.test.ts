import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { wideSystemGraph } from "./wide-system-graph";

// #1666: on a phone-width canvas the built Admin shows every node of a wide system wiring graph,
// initially, after Fit View and after automatic layout, and can still zoom in to a readable scale.
it("fits the whole wide system wiring graph on a narrow canvas", async () => {
  const dist = resolve(import.meta.dirname, "../../dist/admin");
  const snapshot = { dataModel: { schemas: [], views: [] }, logic: { triggers: [], procedures: [] }, interfaces: { http: [], callable: [] }, graph: wideSystemGraph() };
  const bridge = `<script>
    localStorage.setItem('cms.preference.language', 'en');
    const snapshot = ${JSON.stringify(snapshot).replace(/</g, "\\u003c")};
    window.fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === '/admin/api/me') return Response.json({role:'admin', admin:true, developer:true, login:'dev', image:null});
      if (path === '/admin/api/site') return Response.json({brand:'Fixture',icons:[],locales:['en'],canonicalLocale:'en'});
      if (path === '/admin/api/collections') return Response.json({collections:[],allCollections:{}});
      if (path === '/admin/api/operations') return Response.json({operations:[]});
      if (path === '/admin/api/views-manifest') return Response.json({views:[]});
      if (path === '/admin/api/webmcp') return Response.json({tools:[],routes:{}});
      if (path === '/admin/api/developer-console') return Response.json(snapshot);
      return Response.json({});
    };
  </script>`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost");
      if (/^\/admin\/.+\.[a-z0-9]+$/i.test(url.pathname)) {
        const file = resolve(dist, url.pathname.slice("/admin/".length));
        res.setHeader("content-type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "image/svg+xml");
        res.end(await readFile(file));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end((await readFile(resolve(dist, "index.html"), "utf8")).replace("</head>", `${bridge}</head>`));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  const view = (page: Page) => page.evaluate(() => {
    const pane = document.querySelector(".react-flow")!.getBoundingClientRect();
    const nodes = [...document.querySelectorAll(".react-flow__node")].map((node) => node.getBoundingClientRect());
    const zoom = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    return { nodes: nodes.length, outside: nodes.filter((r) => r.left < pane.left - 1 || r.right > pane.right + 1 || r.top < pane.top - 1 || r.bottom > pane.bottom + 1).length, zoom };
  });
  const settled = async (page: Page) => {
    let last = await view(page);
    await expect.poll(async () => { const next = await view(page); const same = next.zoom === last.zoom; last = next; return same; }, { interval: 300 }).toBe(true);
    return last;
  };
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    page.setDefaultTimeout(15_000);
    await page.goto(`${origin}/admin/dev`);
    await page.locator(".react-flow__node").first().waitFor();
    const nodes = snapshot.graph.atoms.length + 5; // atoms plus one group node per audience
    expect(await settled(page)).toMatchObject({ nodes, outside: 0 });
    await page.locator(".react-flow__controls-fitview").click();
    expect(await settled(page)).toMatchObject({ nodes, outside: 0 });
    await page.locator(".react-flow__controls-button").last().click(); // automatic layout
    expect(await settled(page)).toMatchObject({ nodes, outside: 0 });
    for (let i = 0; i < 8; i += 1) await page.locator(".react-flow__controls-zoomin").click();
    expect((await settled(page)).zoom).toBeGreaterThanOrEqual(0.25);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60_000);
