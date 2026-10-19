/// <reference types="node" />
/**
 * `@aotter/mantle-admin/testing`: the compatibility test of an application's Admin MCP App. It loads the App `mantle bundle`
 * built in the official ext-apps `AppBridge`, in a sandboxed iframe from its own origin under the spec's default CSP, and renders
 * every View and page the application customised with sample rows made from the catalogue, in a light and a dark host. It fails on
 * a network request, a console error, an uncaught exception, an App that does not mount, or one that never reports a size.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "playwright-core";
import { declared, type Kind, type McpCsp } from "../build/mcp-check.js";
import { declaredMeta } from "../app/declared-meta.js";
import { toolName } from "../app/tool-name.js";

/** What the test needs of the generated catalogue (`mcpAppCatalogues.admin`). */
export interface McpAppCatalogue {
  readonly views: { readonly [tool: string]: { readonly columns?: { readonly [column: string]: Schema } } };
  readonly actions: { readonly [tool: string]: unknown };
}
interface Schema { readonly type?: string | readonly string[]; readonly format?: string; readonly enum?: readonly unknown[]; readonly const?: unknown; readonly oneOf?: readonly { readonly const?: unknown }[] }

export interface CheckMcpAppOptions {
  /** `mcpAppCatalogues.admin` of `generated/admin-descriptors`. */
  readonly catalogue: McpAppCatalogue;
  /** The built App; `dist/client/admin/mcp-app.html` by default. */
  readonly html?: string;
}

/** What `mantle bundle` records in the file: the Views the application's `cell:view:` slots and `pages[].mcp` pages render. */
interface Manifest { readonly slots: readonly string[]; readonly pages: readonly string[] }

/** After the last request or console message, how long the App is left quiet before the run is judged, and the longest it waits. */
const QUIET_MS = 400, SETTLE_CAP_MS = 5_000;

/** The spec's default CSP for an App that declares none, with what the App declared added as a host adds it. */
function policy(csp: McpCsp): string {
  const add = (base: string, ...lists: (readonly string[] | undefined)[]) => [base, ...lists.flatMap(list => list ?? [])].join(" ");
  const { resourceDomains: resources, connectDomains: connect, frameDomains: frames, baseUriDomains: bases } = csp;
  return [
    "default-src 'none'", `script-src ${add("'self' 'unsafe-inline'", resources)}`, `style-src ${add("'self' 'unsafe-inline'", resources)}`,
    `img-src ${add("'self' data:", resources)}`, `media-src ${add("'self' data:", resources)}`, `font-src ${add("'self'", resources)}`,
    `connect-src ${add("'none'", connect)}`, ...(frames ? [`frame-src ${frames.join(" ")}`] : []), ...(bases ? [`base-uri ${bases.join(" ")}`] : []),
  ].join("; ");
}

/** A plausible value for a column of this schema, so a component sees the shape the View returns; `n` varies the enum member. */
function sample(schema: Schema | undefined, name: string, n: number): unknown {
  const members = schema?.enum ?? (schema?.const !== undefined ? [schema.const] : schema?.oneOf?.flatMap(option => option.const !== undefined ? [option.const] : []));
  if (members?.length) return members[(n - 1) % members.length];
  const type = [schema?.type].flat().find(each => each !== "null");
  switch (type) {
    case "integer": return n * 10;
    case "number": return n + 0.5;
    case "boolean": return n % 2 === 1;
    case "array": return [];
    case "object": return {};
  }
  switch (schema?.format) {
    case "date-time": return `2026-01-0${n}T03:04:05.000Z`;
    case "date": return `2026-01-0${n}`;
    case "time": return "03:04:05";
    case "uri": case "url": return `https://example.com/${name}/${n}`;
    case "email": return `sample${n}@example.com`;
    case "uuid": return `00000000-0000-4000-8000-00000000000${n}`;
  }
  return `${name} ${n}`;
}

/** Three full rows, and a fourth with every nullable column null. */
const rowsOf = (columns: { readonly [column: string]: Schema } | undefined) => [1, 2, 3, 4].map(n => ({
  id: `sample-${n}`, version: 1,
  ...Object.fromEntries(Object.entries(columns ?? {}).map(([column, schema]) => [column, n === 4 && [schema.type].flat().includes("null") ? null : sample(schema, column, n)])),
}));

/** The CSP list a request needs, from what loads it. */
const kindOf = (type: string): Kind => ["fetch", "xhr", "websocket", "eventsource", "ping"].includes(type) ? "connect" : type === "document" ? "frame" : "resource";

/**
 * Renders the application's customised Views and pages in an MCP host and throws one error naming each problem. Needs Chrome or
 * Chromium: set `MANTLE_TEST_CHROMIUM` to its executable, or install one for `playwright-core` (`npx playwright-core install chromium`).
 * Each run waits until the App has been quiet (no request, no console message) for 400 ms, at most 5 s.
 */
export async function checkMcpApp({ catalogue, html: file = "dist/client/admin/mcp-app.html" }: CheckMcpAppOptions): Promise<void> {
  const html = readFileSync(file, "utf8");
  const manifest = declaredMeta<Manifest>(html, "mantle-mcp-app");
  const csp = declaredMeta<McpCsp>(html, "mantle-mcp-csp") ?? {};
  // each View an override renders and each View a page is for; without a manifest (the application customised nothing, or the
  // file is from an older build) every View of the catalogue
  // `rows`: the App's rows table must show; `page`: the application's page, which takes the View over
  const scenarios = new Map<string, { label: string; shows: "rows" | "page" }>();
  for (const slot of manifest?.slots ?? []) {
    const match = /^cell:view:(.+)\.[^.]+$/.exec(slot);
    if (match) scenarios.set(toolName(match[1]!), { label: slot, shows: "rows" });
  }
  for (const view of manifest?.pages ?? []) scenarios.set(toolName(view), { label: `page for ${view}`, shows: "page" });
  if (!manifest) for (const tool of Object.keys(catalogue.views)) scenarios.set(tool, { label: `View ${tool}`, shows: "rows" });
  if (scenarios.size === 0) scenarios.set(Object.keys(catalogue.views)[0] ?? "view", { label: "the App", shows: "rows" });
  const rows: { [tool: string]: ReturnType<typeof rowsOf> } = Object.fromEntries(Object.entries(catalogue.views).map(([tool, view]) => [tool, rowsOf(view.columns)]));
  for (const tool of scenarios.keys()) rows[tool] ??= rowsOf(undefined);

  const hostScript = readFileSync(fileURLToPath(new URL("host.js", import.meta.url)), "utf8");
  const app = html.replace(/<head[^>]*>/i, head => head + '<script type="application/json" id="mantle-catalog">' + JSON.stringify(catalogue).replace(/</g, "\\u003c") + "</script>");

  const playwright = await import("playwright-core").catch(() => { throw new Error("The MCP App compatibility test needs playwright-core: add it to the application's devDependencies (npm install -D playwright-core)."); });
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env["MANTLE_TEST_CHROMIUM"] ? { executablePath: process.env["MANTLE_TEST_CHROMIUM"] } : {}) }).catch((error: Error) => {
    throw new Error(`The MCP App compatibility test found no browser to run. Install one with \`npx playwright-core install chromium\`, or set MANTLE_TEST_CHROMIUM to the path of a Chrome or Chromium executable.\n(${error.message.split("\n")[0]})`);
  });
  const problems: string[] = [];
  try {
    for (const [tool, { label, shows }] of scenarios) for (const theme of ["light", "dark"] as const) {
      const where = `${label}, ${theme} host`;
      const context = await browser.newContext();
      const page = await context.newPage();
      let last = Date.now();
      const note = (problem: string) => { problems.push(`${where}: ${problem}`); last = Date.now(); };
      // the host page and the App come from two origins, as in a real host: the App cannot reach its parent
      await context.route("**/*", async (route: Route) => {
        const request = route.request(), url = request.url(), { origin, pathname } = new URL(url);
        if (origin === "https://host.test" && pathname === "/host.html") return route.fulfill({ contentType: "text/html", body: '<!doctype html><title>host</title><body><script src="/host.js"></script></body>' });
        if (origin === "https://host.test" && pathname === "/host.js") return route.fulfill({ contentType: "text/javascript", body: hostScript });
        if (origin === "https://app.test" && pathname === "/app.html") return route.fulfill({ contentType: "text/html", headers: { "content-security-policy": policy(csp) }, body: app });
        if (pathname === "/favicon.ico") return route.fulfill({ status: 204 });
        // the App declared this origin for this kind of use: a real host would allow it; there is no network here, so answer nothing
        if (declared(url, csp, kindOf(request.resourceType()))) return route.fulfill({ status: 204 });
        note(`a network request to ${url}`);
        return route.abort();
      });
      page.on("console", message => { if (message.type() === "error") note(`console error: ${message.text()}`); else last = Date.now(); });
      page.on("pageerror", error => note(`uncaught exception: ${error.message}`));
      await page.addInitScript(`window.__mantleScenario = ${JSON.stringify({ tool, theme, rows })};`);
      await page.goto("https://host.test/host.html");
      const state = () => page.evaluate(() => (window as unknown as { host?: { state: { done: boolean; height: number }; errors: string[] } }).host ?? null);
      const frame = (): ReturnType<Page["frames"]>[number] | undefined => page.frames().find(each => each.url().startsWith("https://app.test/"));
      // the result is delivered and the App shows the content: its rows table, or the application's page (not the full-screen toggle),
      // and its waiting text is gone
      let shown = { rows: false, page: false, waiting: true, dark: false };
      const started = Date.now();
      for (;;) {
        const host = await state(), seen = await frame()?.evaluate(() => {
          const page = document.querySelector<HTMLElement>('[data-slot="app-page"]');
          const visible = (node: Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
          // Empty layout wrappers are not content. A native page heading is text;
          // a canvas, image or control may legitimately render without any text.
          const content = page && visible(page) && (page.innerText.trim().length > 0
            || [...page.querySelectorAll('img, svg, canvas, video, audio, iframe, object, embed, input:not([type="hidden"]), button, select, textarea')].some(visible));
          return {
            rows: document.querySelector('[data-slot="app-rows"]') !== null,
            page: !!content,
            waiting: /Waiting for results/.test(document.body.innerText),
            dark: document.documentElement.classList.contains("dark"),
          };
        }).catch(() => undefined);
        if (seen) shown = seen;
        if (host?.state.done && !shown.waiting && shown[shows]) break;
        if (Date.now() - started > 10_000) { note(`the App did not render the ${shows === "page" ? "page" : "View's rows"} (${shown.waiting ? "it still shows its waiting text" : shows === "page" ? "the page is empty or missing" : "no rows table"})`); break; }
        await page.waitForTimeout(100);
      }
      if (theme === "dark" && !shown.dark) note("the App did not take the host's dark theme (no .dark on its root)");
      // a request or an error may come after the first paint: wait for quiet
      last = Date.now();
      const quiet = Date.now();
      while (Date.now() - last < QUIET_MS && Date.now() - quiet < SETTLE_CAP_MS) await page.waitForTimeout(50);
      const host = await state();
      if (!host || host.state.height <= 0) note("the App reported no size (size-changed with a positive height)");
      for (const error of host?.errors ?? []) note(`host error: ${error}`);
      await context.close();
    }
  } finally { await browser.close(); }
  if (problems.length) throw new Error(`The Admin MCP App is not compatible with an MCP host:\n${[...new Set(problems)].map(line => `  - ${line}`).join("\n")}`);
}
