import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { buildDefaultAdmin } from "./built-admin";

// Paged lists append the next page ("Load more") and have no Previous: cursors are opaque, and a page's size varies.
it("appends the next page of a View and of the members list, and offers no Previous", async () => {
  const built = await buildDefaultAdmin();
  const dist = built.dist;
  const bridge = () => `<script>
    localStorage.setItem('cms.preference.language', 'en');
    const requests = window.requests = [];
    const member = (id) => ({ id, name: 'Member ' + id, email: id + '@example.com', emailVerified: true, createdAt: '2026-10-01T00:00:00.000Z', role: null });
    window.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      const path = url.pathname, cursor = url.searchParams.get('cursor');
      requests.push(path + url.search);
      if (path === '/admin/api/me') return Response.json({role:'admin', admin:true, developer:true, login:'dev', image:null});
      if (path === '/admin/api/site') return Response.json({brand:'Fixture',icons:[],locales:['en'],canonicalLocale:'en'});
      if (path === '/admin/api/collections') return Response.json({collections:[],allCollections:{}});
      if (path === '/admin/api/operations') return Response.json({operations:[]});
      if (path === '/admin/api/views-manifest') return Response.json({views:[{ name:'orders', title:null, description:null, input:null, list:{columns:['item'],searchFields:[],filterFields:[]}, columns:{} }]});
      if (path === '/admin/api/webmcp') return Response.json({tools:[],routes:{}});
      if (path === '/admin/api/views/orders') return Response.json(cursor ? { rows: [{ id: 'o3', item: 'Third order' }] } : { rows: [{ id: 'o1', item: 'First order' }, { id: 'o2', item: 'Second order' }], nextCursor: 'c2' });
      if (path === '/admin/api/members') return Response.json(cursor ? { items: [member('m3')], previous_cursor: 'c1', next_cursor: null } : { items: [member('m1'), member('m2')], previous_cursor: null, next_cursor: 'c2' });
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
  try {
    for (const { path, first, second, last, api } of [
      { path: "/admin/views/orders", first: "First order", second: "Second order", last: "Third order", api: "/admin/api/views/orders" },
      { path: "/admin/members", first: "Member m1", second: "Member m2", last: "Member m3", api: "/admin/api/members" },
    ]) {
      const page = await browser.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(`${origin}${path}`);
      await page.getByText(first).waitFor();
      expect(await page.getByRole("link", { name: /previous/i }).count()).toBe(0);
      await page.getByRole("button", { name: "Load more" }).click();
      await page.getByText(last).waitFor();
      // the page loaded first stays, and the end of the list has no button
      await page.getByText(first).waitFor();
      await page.getByText(second).waitFor();
      expect(await page.getByRole("button", { name: "Load more" }).count()).toBe(0);
      expect(await page.getByText(/previous|next/i).count()).toBe(0);
      const sent = (await page.evaluate(() => (window as any).requests as string[])).filter(request => request.startsWith(api));
      expect(sent.map(request => new URL(request, origin).searchParams.get("cursor"))).toEqual([null, "c2"]);
      expect(page.url()).toBe(`${origin}${path}`);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    built.remove();
  }
}, 120_000);
