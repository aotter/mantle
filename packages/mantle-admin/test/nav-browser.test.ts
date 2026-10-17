import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("keeps preset navigation active, expandable, keyboard reachable and mobile-collapsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-admin-nav-"));
  const dist = join(root, "admin"), entry = join(root, "entry.tsx");
  await writeFile(entry, `import { defineAdmin } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/index.js"))};
export default defineAdmin({}, { nav: {
  groups: { triage: { title: "Triage", order: 5 } },
  items: [
    { group: "triage", title: "All orders", order: 1, to: { collection: "orders" } },
    { group: "triage", title: "Rejected orders", order: 2, to: { collection: "orders", filter: { state: "rejected" } } },
  ],
} });
`);
  const { buildAdmin } = await import("../dist/build/index.js");
  await buildAdmin({ entry, outDir: dist });
  const bridge = `<script>
    localStorage.setItem('cms.preference.language', 'en');
    const schema = {type:'object',properties:{title:{type:'string'},state:{type:'string',enum:['open','rejected']}},required:['title','state']};
    const requests = {name:'requests',exportFields:['title'],title:'Requests',description:null,lifecycle:'operational',parent:null,localized:false,hasTranslations:false,filter:{field:'state',values:['open','rejected']},list:{primaryField:'title',columns:['title','state']},uiSchema:{nav:{group:'triage',order:3}},nav:null,translates:null,schema};
    const orders = {...requests,name:'orders',title:'Orders',filter:null,uiSchema:{nav:{hidden:true}}};
    const collections = [requests, orders];
    const me = {role:'admin',admin:true,developer:false,login:'fixture',image:null};
    const site = {brand:'Fixture',icons:[],locales:['en'],canonicalLocale:'en'};
    window.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url), path = url.pathname;
      if (path === '/admin/api/me') return Response.json(me);
      if (path === '/admin/api/site') return Response.json(site);
      if (path === '/admin/api/collections') return Response.json({collections,allCollections:{requests,orders}});
      if (path === '/admin/api/operations') return Response.json({operations:[]});
      if (path === '/admin/api/views-manifest') return Response.json({views:[]});
      if (path === '/admin/api/webmcp') return Response.json({tools:[],routes:{}});
      if (path === '/admin/api/bootstrap') return Response.json({me,collections,allCollections:{requests,orders},site,operations:[],views:[],webmcp:{tools:[],routes:{}},entries:{items:[],next_cursor:null}});
      if (path === '/admin/api/entries/r1') return Response.json({collection:requests,entry:{id:'r1',collection:'requests',locale:null,status:null,version:1,data:{title:'Request one',state:'rejected'},updated_at:0},parentEntryId:null,related:[]});
      if (path === '/admin/api/entries') return Response.json({items:[],next_cursor:null});
      return Response.json({});
    };
  </script>`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://localhost");
      if (/^\/admin\/.+\.[a-z0-9]+$/i.test(url.pathname)) {
        const file = resolve(dist, url.pathname.slice("/admin/".length));
        response.setHeader("content-type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "image/svg+xml");
        response.end(await readFile(file));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end((await readFile(join(dist, "index.html"), "utf8")).replace("</head>", `${bridge}</head>`));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${origin}/admin/c/orders?filter_field=state&filter_value=rejected`);
    const allOrders = page.getByRole("link", { name: "All orders", exact: true });
    const rejectedOrders = page.getByRole("link", { name: "Rejected orders", exact: true });
    await rejectedOrders.waitFor();
    expect(await allOrders.getAttribute("data-active")).toBe("false");
    expect(await rejectedOrders.getAttribute("data-active")).toBe("true");

    for (const path of [
      "/admin/c/requests?filter_field=state&filter_value=rejected",
      "/admin/c/requests/r1?filter_field=state&filter_value=rejected",
    ]) {
      await page.goto(origin + path);
      const requests = page.getByRole("button", { name: "Requests", exact: true });
      await requests.waitFor();
      const requestNav = page.locator('[data-slot="collapsible"]').filter({ has: requests });
      expect(await requests.getAttribute("aria-expanded")).toBe("true");
      expect(await requestNav.getByRole("link", { name: "All", exact: true }).getAttribute("data-active")).toBe("false");
      expect(await requestNav.getByRole("link", { name: /^rejected$/i }).getAttribute("data-active")).toBe("true");
    }

    const requests = page.getByRole("button", { name: "Requests", exact: true });
    await rejectedOrders.focus();
    await page.keyboard.press("Tab");
    expect(await requests.evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    expect(await requests.getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("Space");
    expect(await requests.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("Tab");
    expect(await page.locator('[data-slot="collapsible"]').filter({ has: requests }).getByRole("link", { name: "All", exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await page.waitForURL(`${origin}/admin/c/requests`);

    const mobile = await browser.newPage({ viewport: { width: 375, height: 812 } });
    mobile.setDefaultTimeout(15_000);
    await mobile.goto(`${origin}/admin`);
    await mobile.getByRole("button", { name: "Toggle sidebar" }).click();
    const sheet = mobile.locator('[data-sidebar="sidebar"][data-mobile="true"]');
    await sheet.waitFor();
    await sheet.getByRole("link", { name: "Rejected orders", exact: true }).click();
    await mobile.waitForURL(`${origin}/admin/c/orders?filter_field=state&filter_value=rejected`);
    await sheet.waitFor({ state: "hidden" });
    // Activating the already-current item changes no route, so only the link itself can close the sheet.
    await mobile.getByRole("button", { name: "Toggle sidebar" }).click();
    await sheet.waitFor();
    await sheet.getByRole("link", { name: "Rejected orders", exact: true }).click();
    await sheet.waitFor({ state: "hidden" });
    await mobile.close();
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
