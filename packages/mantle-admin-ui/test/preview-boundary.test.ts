import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("keeps the built preview on its bridge, including search and downloads, while canonical Auth works", async () => {
  const network: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost");
      res.setHeader("content-type", "text/html");
      if (url.pathname === "/host") {
        res.end(`<iframe src="/preview?route=${encodeURIComponent(url.searchParams.get("route") ?? "/admin/views/report")}" style="width:100%;height:900px"></iframe>`);
        return;
      }
      if (url.pathname === "/preview" || url.pathname === "/canonical") {
        const document = await readFile(resolve("dist", url.pathname === "/preview" ? "preview.html" : "index.html"), "utf8");
        const route = url.searchParams.get("route") ?? "/admin/sign-in";
        // Deliberately incomplete consumer bridge: unknown requests fall through
        // to native fetch. The SDK must still prevent live API access.
        const bridge = `<script>
          localStorage.setItem('cms.preference.language', 'en');
          history.replaceState(null, '', ${JSON.stringify(route).replace(/</g, "\\u003c")});
          if (parent !== self) {
            window.bridged = [];
            const nativeFetch = window.fetch.bind(window);
            window.fetch = async (input, init) => {
              const request = new Request(input, init);
              const url = new URL(request.url);
              const path = url.pathname;
              window.bridged.push(path + url.search);
              if (path === '/admin/api/webmcp') return Response.json({tools:[],routes:{}});
              if (path === '/admin/api/me') return Response.json({role:'owner',login:'sandbox',image:null}, {status:${route === "/admin/unauthorized" ? 401 : 200}});
              if (path === '/admin/api/site') return Response.json({brand:'Sandbox',icons:[],locales:['en'],canonicalLocale:'en'});
              if (path === '/admin/api/collections') return Response.json({collections:[]});
              if (path === '/admin/api/operations') return Response.json({operations:[]});
              if (path === '/admin/api/views-manifest') return Response.json({views:[{name:'report',title:'Report',surface:'staff',from:null,params:null,fields:['name'],list:{columns:['name'],searchFields:['name'],filterFields:[]}}]});
              if (path === '/admin/api/views/report/export') return new Response('name\\nAda', {headers:{'content-type':'text/csv','content-disposition':'attachment; filename="report.csv"'}});
              if (path === '/admin/api/views/report') return Response.json({ok:true,data:{rows:[{name:'Ada'}],page:1,show:50,hasMore:false}});
              return nativeFetch(input, init);
            };
            window.__MANTLE_ADMIN_PREVIEW__ = {fetch:window.fetch};
          }
        </script>`;
        res.end(document.replace("</head>", `${bridge}</head>`));
        return;
      }
      if (url.pathname.startsWith("/_mantle/admin/")) {
        const file = resolve("dist", url.pathname.slice("/_mantle/admin/".length));
        res.setHeader("content-type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "image/svg+xml");
        res.end(await readFile(file));
        return;
      }
      if (url.pathname === "/favicon.ico") { res.end(); return; }
      network.push(`${req.method} ${url.pathname}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(url.pathname === "/api/auth/methods" ? {methods:[{kind:"email-otp"}]} : {}));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(`${origin}/host`);
    const frame = page.frames()[1]!;
    await frame.getByRole("cell", {name:"Ada",exact:true}).waitFor();
    const tools = await page.evaluate(() => new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => { resolve(event.data); channel.port1.close(); };
      document.querySelector("iframe")!.contentWindow!.postMessage({ type: "mantle:admin-tools:request", protocolVersion: 1, method: "list" }, location.origin, [channel.port2]);
    }));
    expect(tools).toMatchObject({ok:true,result:{tools:expect.arrayContaining([expect.objectContaining({name:"admin_navigate"})])}});

    await frame.getByRole("search").getByRole("textbox").fill("Ada");
    await frame.getByRole("search").getByRole("button", {name:"Search",exact:true}).click();
    await expect.poll(() => frame.url()).toContain("search=Ada");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      frame.getByRole("button", {name:"Export CSV",exact:true}).click(),
    ]);
    expect(download.suggestedFilename()).toBe("report.csv");
    const result = await frame.evaluate(async () => {
      const blocked: boolean[] = [];
      for (const path of ["/oauth/consents/data", "/api/auth/sign-out", "/admin/api/unhandled", "https://foreign.example.test/admin/api/me"]) {
        try { await fetch(path); blocked.push(false); } catch { blocked.push(true); }
      }
      const xhrBlocked = await new Promise<boolean>(resolve => {
        const xhr = new XMLHttpRequest(); xhr.open("POST", "/oauth/consents/revoke");
        xhr.onerror = () => resolve(true); xhr.onload = () => resolve(false); xhr.send();
      });
      const form = document.createElement("form"); form.method = "POST"; form.action = "/oauth/consents/revoke";
      document.body.append(form); form.submit();
      navigator.sendBeacon("/oauth/consents/revoke", "sandbox");
      return {blocked,xhrBlocked,bridged:(window as unknown as {bridged:string[]}).bridged};
    });
    expect(result.blocked).toEqual([true,true,true,true]);
    expect(result.xhrBlocked).toBe(true);
    // Browsers may report an accepted beacon even when CSP blocks transmission.
    expect(result.bridged).toContain("/admin/api/views/report/export?search=Ada");
    await page.goto(`${origin}/host?route=/admin/connected-apps`);
    await page.frames()[1]!.getByRole("heading", {name:"Sandbox preview"}).waitFor();
    expect(network).toEqual([]);
    await page.goto(`${origin}/host?route=/admin/unauthorized`);
    await page.frames()[1]!.getByRole("alert").filter({hasText:"401"}).waitFor();
    expect(page.frames()[1]!.url()).toBe(`${origin}/admin/unauthorized`);
    expect(network).toEqual([]);

    // The opt-in document cannot turn into a standalone production Admin.
    await page.goto(`${origin}/preview?route=/admin/sign-in`);
    expect(await page.locator("#root").textContent()).toBe("");
    expect(network).toEqual([]);
    await page.goto(`${origin}/canonical`);
    await page.getByRole("textbox").waitFor();
    expect(network).toContain("GET /api/auth/methods");
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);
