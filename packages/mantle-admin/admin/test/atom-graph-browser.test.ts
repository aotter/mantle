import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { buildDefaultAdmin } from "./built-admin";
import { tallSystemGraph, wideSystemGraph } from "./wide-system-graph";
import procedureSnapshot from "./fixtures/purchasing-approve.snapshot.json";

// #1666: the built Admin shows every node of a large system wiring graph, initially, after Fit View
// and after automatic layout, and can still zoom in to a readable scale. A wide graph on a phone in
// portrait and a tall graph on a short landscape canvas.
it("fits the whole system wiring graph on narrow and short canvases", async () => {
  const built = await buildDefaultAdmin();
  const dist = built.dist;
  let snapshot = {};
  const bridge = () => `<script>
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
      res.end((await readFile(resolve(dist, "index.html"), "utf8")).replace("</head>", `${bridge()}</head>`));
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
    const cases = [
      { graph: wideSystemGraph(), columns: 4, viewport: { width: 375, height: 812 } },
      { graph: tallSystemGraph(), columns: 3, viewport: { width: 740, height: 360 } },
      // needs a zoom far below any fixed floor (#1666 review: 431 of 1002 nodes outside at 0.02)
      { graph: tallSystemGraph(500), columns: 3, viewport: { width: 740, height: 360 }, zoomIn: false },
    ];
    for (const { graph, columns, viewport, zoomIn = true } of cases) {
      snapshot = { dataModel: { schemas: [], views: [] }, logic: { triggers: [], procedures: [] }, interfaces: { http: [], callable: [] }, graph };
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(15_000);
      await page.goto(`${origin}/admin/dev`);
      await page.locator(".react-flow__node").first().waitFor();
      const nodes = graph.atoms.length + columns; // atoms plus one header per column
      expect(await settled(page), `initial ${viewport.width}x${viewport.height}`).toMatchObject({ nodes, outside: 0 });
      await page.locator(".react-flow__controls-fitview").click();
      expect(await settled(page), `Fit View ${viewport.width}x${viewport.height}`).toMatchObject({ nodes, outside: 0 });
      await page.locator(".react-flow__controls-button").last().click(); // automatic layout
      expect(await settled(page), `layout ${viewport.width}x${viewport.height}`).toMatchObject({ nodes, outside: 0 });
      if (zoomIn) {
        // up to 12 steps; the compact wiring cards can reach the maximum zoom sooner, which disables the button
        for (let i = 0; i < 12 && await page.locator(".react-flow__controls-zoomin").isEnabled(); i += 1) await page.locator(".react-flow__controls-zoomin").click();
        expect((await settled(page)).zoom).toBeGreaterThanOrEqual(0.25);
      }
      await page.close();
    }
    // A canvas mounted while hidden (a closed <details>) fitted itself to zero size: every Procedure graph, in the page,
    // its dialogs and the SQL syntax trees, must show its cards at a readable size.
    snapshot = procedureSnapshot;
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(15_000);
    const readable = () => page.evaluate(() => [...document.querySelectorAll(".react-flow")].filter((flow) => flow.checkVisibility()).map((flow) => {
      const pane = flow.getBoundingClientRect();
      const nodes = [...flow.querySelectorAll(".react-flow__node")].map((node) => node.getBoundingClientRect());
      const span = (lo: (r: DOMRect) => number, hi: (r: DOMRect) => number) => Math.max(...nodes.map(hi)) - Math.min(...nodes.map(lo));
      return nodes.length > 0 && Math.max(span((r) => r.left, (r) => r.right) / pane.width, span((r) => r.top, (r) => r.bottom) / pane.height) > 0.25;
    }));
    await page.goto(`${origin}/admin/dev/logic/procedures?selected=Procedure%3Aapprove-request-write`);
    await page.locator(".react-flow__node").first().waitFor();
    await page.getByText("Advanced: SQL syntax trees").click();
    await expect.poll(readable, { interval: 300 }).toEqual([true, true, true, true]);
    await page.getByRole("button", { name: "Expand SQL graph" }).first().click();
    await expect.poll(readable, { interval: 300 }).toEqual([true, true, true, true, true]);
    await page.close();
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    built.remove();
  }
}, 120_000);
