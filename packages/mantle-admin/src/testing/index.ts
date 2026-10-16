/// <reference types="node" />
/**
 * `@aotter/mantle-admin/testing`: the compatibility test of an application's Admin MCP App. It loads the App `mantle bundle`
 * built in the official ext-apps `AppBridge`, in a sandboxed iframe under the spec's default CSP, and renders every View and page
 * the application customised with sample rows made from the catalogue, in a light and a dark host. It fails on a network request,
 * a console error, an uncaught exception, or an App that never reports a size.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

/** What `mantle bundle` records in the file: the `both` slots the application overrides and the Views its `pages[].mcp` render. */
interface Manifest { readonly slots: readonly string[]; readonly pages: readonly string[] }

/** The spec's default CSP for an App that declares none, with what the App declared added as a host adds it. */
function policy(csp: { readonly [list: string]: readonly string[] | undefined }): string {
  const add = (base: string, ...lists: (readonly string[] | undefined)[]) => [base, ...lists.flatMap(list => list ?? [])].join(" ");
  const resources = csp["resourceDomains"], connect = csp["connectDomains"];
  return [
    "default-src 'none'", `script-src ${add("'self' 'unsafe-inline'", resources)}`, `style-src ${add("'self' 'unsafe-inline'", resources)}`,
    `img-src ${add("'self' data:", resources)}`, `media-src ${add("'self' data:", resources)}`, `font-src ${add("'self'", resources)}`,
    `connect-src ${add("'none'", connect)}`, ...(csp["frameDomains"] ? [`frame-src ${csp["frameDomains"].join(" ")}`] : []), ...(csp["baseUriDomains"] ? [`base-uri ${csp["baseUriDomains"].join(" ")}`] : []),
  ].join("; ");
}

/** The admin MCP tool of a View: its name lowercased, kebab to snake (as `@aotter/mantle`'s compiler names it). */
const toolName = (view: string): string => view.toLowerCase().replace(/-/g, "_");

/** A plausible value for a column of this schema, so a component sees the shape the View returns. */
function sample(schema: Schema | undefined, name: string, n: number): unknown {
  const first = schema?.enum?.[0] ?? schema?.const ?? schema?.oneOf?.find(option => option.const !== undefined)?.const;
  if (first !== undefined) return first;
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

const rowsOf = (columns: { readonly [column: string]: Schema } | undefined) =>
  [1, 2, 3].map(n => ({ id: `sample-${n}`, version: 1, ...Object.fromEntries(Object.entries(columns ?? {}).map(([column, schema]) => [column, sample(schema, column, n)])) }));

function declared<T>(html: string, name: string): T | undefined {
  const content = new RegExp(`<meta name="${name}" content='([^']*)'>`).exec(html)?.[1];
  return content ? JSON.parse(content) as T : undefined;
}

type Browser = { newContext(options?: object): Promise<Context>; close(): Promise<void> };
type Context = { route(url: string, handler: (route: Route) => unknown): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> };
type Route = { request(): { url(): string; resourceType(): string }; fulfill(response: object): Promise<void>; abort(): Promise<void> };
type Page = { on(event: string, handler: (value: never) => void): void; addInitScript(script: string): Promise<void>; goto(url: string): Promise<unknown>; evaluate<T>(script: () => T): Promise<T>; waitForTimeout(ms: number): Promise<void> };

/**
 * Renders the application's customised Views and pages in an MCP host and throws one error naming each problem. Needs Chrome or
 * Chromium: set `MANTLE_TEST_CHROMIUM` to its executable, or install one for `playwright-core` (`npx playwright-core install chromium`).
 */
export async function checkMcpApp({ catalogue, html: file = "dist/client/admin/mcp-app.html" }: CheckMcpAppOptions): Promise<void> {
  const html = readFileSync(file, "utf8");
  const manifest = declared<Manifest>(html, "mantle-mcp-app") ?? { slots: [], pages: [] };
  const csp = declared<{ [list: string]: readonly string[] }>(html, "mantle-mcp-csp") ?? {};
  // each View an override renders, and each View a page is for; any View of the catalogue when the application customised none
  const scenarios = new Map<string, string>();
  for (const slot of manifest.slots) {
    const match = /^cell:view:(.+)\.[^.]+$/.exec(slot);
    if (match) scenarios.set(toolName(match[1]!), slot);
  }
  for (const view of manifest.pages) scenarios.set(toolName(view), `page for ${view}`);
  if (scenarios.size === 0) { const [tool = "view"] = Object.keys(catalogue.views); scenarios.set(tool, "the App"); }
  const rows: { [tool: string]: ReturnType<typeof rowsOf> } = Object.fromEntries(Object.entries(catalogue.views).map(([tool, view]) => [tool, rowsOf(view.columns)]));
  for (const tool of scenarios.keys()) rows[tool] ??= rowsOf(undefined);

  const hostScript = readFileSync(resolve(dirname(new URL(import.meta.url).pathname), "host.js"), "utf8");
  const app = html.replace(/<head[^>]*>/i, head => head + '<script type="application/json" id="mantle-catalog">' + JSON.stringify(catalogue).replace(/</g, "\\u003c") + "</script>");
  const allowed = new Set([...(csp["resourceDomains"] ?? []), ...(csp["connectDomains"] ?? []), ...(csp["frameDomains"] ?? [])].map(domain => { try { return new URL(domain).host; } catch { return domain; } }));

  const playwright = await import("playwright-core" as string).catch(() => { throw new Error("The MCP App compatibility test needs playwright-core: add it to the application's devDependencies (npm install -D playwright-core)."); }) as { chromium: { launch(options: object): Promise<Browser> } };
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env["MANTLE_TEST_CHROMIUM"] ? { executablePath: process.env["MANTLE_TEST_CHROMIUM"] } : {}) }).catch((error: Error) => {
    throw new Error(`The MCP App compatibility test found no browser to run. Install one with \`npx playwright-core install chromium\`, or set MANTLE_TEST_CHROMIUM to the path of a Chrome or Chromium executable.\n(${error.message.split("\n")[0]})`);
  });
  const problems: string[] = [];
  try {
    for (const [tool, label] of scenarios) for (const theme of ["light", "dark"] as const) {
      const where = `${label}, ${theme} host`;
      const context = await browser.newContext();
      const page = await context.newPage();
      await context.route("**/*", async route => {
        const url = route.request().url(), { pathname: path, origin, host } = new URL(url), own = origin === "https://host.test";
        if (own && path === "/host.html") return route.fulfill({ contentType: "text/html", body: '<!doctype html><title>host</title><body><script src="/host.js"></script></body>' });
        if (own && path === "/host.js") return route.fulfill({ contentType: "text/javascript", body: hostScript });
        if (own && path === "/app.html") return route.fulfill({ contentType: "text/html", headers: { "content-security-policy": policy(csp) }, body: app });
        if (own && path === "/favicon.ico") return route.fulfill({ status: 204 });
        // the App declared this origin: a real host would allow it; there is no network here, so answer nothing
        if (allowed.has(host)) return route.fulfill({ status: 204 });
        problems.push(`${where}: a network request to ${url}`);
        return route.abort();
      });
      page.on("console", (message: { type(): string; text(): string }) => { if (message.type() === "error") problems.push(`${where}: console error: ${message.text()}`); });
      page.on("pageerror", (error: Error) => problems.push(`${where}: uncaught exception: ${error.message}`));
      await page.addInitScript(`window.__mantleScenario = ${JSON.stringify({ tool, theme, rows })};`);
      await page.goto("https://host.test/host.html");
      const sized = async () => page.evaluate(() => (window as unknown as { host?: { sizes: { height: number }[] } }).host?.sizes.some(size => size.height > 0) ?? false);
      for (let attempt = 0; attempt < 100 && !(await sized()); attempt++) await page.waitForTimeout(100);
      // a request or an error may come after the first paint: let effects and images settle
      await page.waitForTimeout(500);
      if (!(await sized())) problems.push(`${where}: the App reported no size (size-changed with a positive height)`);
      const host = await page.evaluate(() => (window as unknown as { host?: { errors: string[] } }).host?.errors ?? []);
      for (const error of host) problems.push(`${where}: host error: ${error}`);
      await context.close();
    }
  } finally { await browser.close(); }
  if (problems.length) throw new Error(`The Admin MCP App is not compatible with an MCP host:\n${[...new Set(problems)].map(line => `  - ${line}`).join("\n")}`);
}
