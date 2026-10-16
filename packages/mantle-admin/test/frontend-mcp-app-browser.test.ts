import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";

it("application frontend builds without Admin and renders/pages through official AppBridge", async () => {
  const root = resolve(import.meta.dirname, "../../.."), pkg = resolve(import.meta.dirname, "..");
  const coreRequire = createRequire(resolve(root, "packages/mantle/package.json"));
  const { build } = coreRequire("esbuild");
  const require = createRequire(resolve(pkg, "package.json"));
  const alias = {
    react: resolve(require.resolve("react"), ".."), "react-dom": resolve(require.resolve("react-dom/client"), ".."),
    "@aotter/mantle-ui": resolve(root, "packages/mantle-ui/src/index.ts"),
    "@modelcontextprotocol/ext-apps/react": require.resolve("@modelcontextprotocol/ext-apps/react"),
    "@modelcontextprotocol/ext-apps/app-bridge": require.resolve("@modelcontextprotocol/ext-apps/app-bridge"),
    "@modelcontextprotocol/ext-apps": require.resolve("@modelcontextprotocol/ext-apps"),
  };
  const frontend = await build({ entryPoints: [resolve(root, "docs/examples/frontend-mcp-app/app.tsx")], bundle: true, write: false, metafile: true, minify: true, platform: "browser", format: "esm", jsx: "automatic", alias });
  expect(Object.keys(frontend.metafile!.inputs).filter(path => /packages\/mantle(?:-admin)?\/(?:src|admin|dist)\//.test(path))).toEqual([]);
  expect(Object.keys(frontend.metafile!.inputs).some(path => path.includes("mantle-ui/src/"))).toBe(true);
  const host = await build({ stdin: { contents: `
import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const frame=document.createElement('iframe');frame.sandbox='allow-scripts';document.body.append(frame);
const calls=[];window.host={calls,ready:false};
const result=(rows,nextCursor)=>({content:[{type:'text',text:JSON.stringify({rows,nextCursor})}],structuredContent:{rows,...(nextCursor?{nextCursor}:{})}});
const bridge=new AppBridge(null,{name:'frontend-test',version:'1'},{serverTools:{}},{hostContext:{}});
bridge.oninitialized=()=>{window.host.ready=true;void bridge.sendToolResult(result([{id:'a1',version:1,title:'Alice one'}],'next'));};
bridge.oncalltool=async params=>{calls.push(params);return result([{id:'a2',version:1,title:'Alice two'}]);};
bridge.onsizechange=()=>{};window.host.bridge=bridge;
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/app';
`, resolveDir: pkg }, bundle: true, write: false, platform: "browser", format: "esm", alias });
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("content-type", request.url?.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(request.url === "/host.js" ? host.outputFiles[0]!.text : request.url === "/app.js" ? frontend.outputFiles[0]!.text : request.url === "/app" ? '<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>' : '<!doctype html><script type="module" src="/host.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const address = server.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}`);
    const app = page.frameLocator("iframe");
    await app.getByText("Alice one").waitFor();
    await app.getByRole("button", { name: "Load more" }).click();
    await app.getByText("Alice two").waitFor();
    expect(await app.getByText("Alice one").count()).toBe(1);
    expect(await app.getByRole("button", { name: "Load more" }).count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { host: { calls: unknown[] } }).host.calls)).toMatchObject([{ name: "my_tasks", arguments: { limit: 1, cursor: "next" } }]);
    // Official content-only replies and optional null cursors are supported.
    await page.evaluate(async () => {
      const bridge = (window as any).host.bridge;
      await bridge.sendToolResult({ content: [{ type: "text", text: JSON.stringify({ rows: [{ id: "c1", title: "Content only", version: 2 }], nextCursor: null }) }] });
    });
    await app.getByText("Content only").waitFor();
    expect(await app.getByRole("button", { name: "Load more" }).count()).toBe(0);
    await page.evaluate(async () => (window as any).host.bridge.sendToolResult({ content: [{ type: "text", text: "truncated {" }] }));
    await app.getByRole("alert").waitFor();
    await page.evaluate(async () => (window as any).host.bridge.sendToolResult({ content: [], structuredContent: { rows: [{ id: "r1", title: "Recovered", version: 3 }], nextCursor: "old" } }));
    await app.getByText("Recovered").waitFor();
    expect(await app.getByRole("alert").count()).toBe(0);
    // A new result supersedes a pending page: its old rows must never append.
    await page.evaluate(() => { (window as any).host.bridge.oncalltool = () => new Promise(resolve => { (window as any).host.finishPage = resolve; }); });
    await app.getByRole("button", { name: "Load more" }).click();
    await page.waitForFunction(() => typeof (window as any).host.finishPage === "function");
    await page.evaluate(async () => (window as any).host.bridge.sendToolResult({ content: [], structuredContent: { rows: [{ id: "new", title: "Latest result", version: 4 }] } }));
    await app.getByText("Latest result").waitFor();
    await page.evaluate(() => (window as any).host.finishPage({ content: [], structuredContent: { rows: [{ id: "stale", title: "Stale row", version: 1 }] } }));
    await expect.poll(() => app.locator("main").getAttribute("aria-busy")).toBe("false");
    await app.getByText("Latest result").waitFor();
    expect(await app.getByRole("button", { name: "Load more" }).count()).toBe(0);
    expect(await app.getByText("Stale row").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);
