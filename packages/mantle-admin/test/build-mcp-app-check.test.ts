import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkMcpApp, cspProblems, declared, hitsOf } from "../src/build/mcp-check.js";

const pkg = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "mantle-mcp-check-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const { buildAdmin } = await import(resolve(pkg, "dist/build/index.js")) as typeof import("../src/build/index.js");

/** An application entry whose `cell:view:pending.item` override is `cell` from `src/cell.tsx`, and the rest of `defineAdmin`'s options. */
function app(name: string, cell: string, options = ""): { entry: string; out: string } {
  const src = join(temp, name, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "cell.tsx"), cell);
  writeFileSync(join(src, "admin.tsx"), [
    `import { defineAdmin } from ${JSON.stringify(resolve(pkg, "dist/admin-app/index.js"))};`,
    'import { Cell } from "./cell";',
    `export default defineAdmin({}, { components: { "cell:view:pending.item": Cell }${options} });`,
  ].join("\n"));
  return { entry: join(src, "admin.tsx"), out: join(temp, name, "dist/admin") };
}
const attempt = async ({ entry, out }: { entry: string; out: string }) => buildAdmin({ entry, outDir: out }).then(() => undefined, (error: Error) => error.message);

describe("the checks on the built MCP App", () => {
  it("builds an app whose Sidebar override uses the kit's SidebarProvider, which writes the sidebar's cookie", async () => {
    const kit = resolve(pkg, "../mantle-ui/dist/kit/index.js");
    const fixture = app("sidebar", "export const Cell = () => <b>x</b>;");
    writeFileSync(join(fixture.entry, "../side.tsx"), `import { SidebarProvider } from ${JSON.stringify(kit)};\nexport const Side = () => <SidebarProvider>side</SidebarProvider>;`);
    writeFileSync(fixture.entry, readFileSync(fixture.entry, "utf8").replace("import { Cell }", 'import { Side } from "./side";\nimport { Cell }').replace("components: {", "components: { Sidebar: Side,"));
    expect(await attempt(fixture)).toBeUndefined();
    expect(readFileSync(join(fixture.out, "mcp-app.html"), "utf8")).toContain("document.cookie");
  }, 120_000);

  it("fails on a remote fetch the CSP lists only as a resource, and passes when connectDomains has it", async () => {
    const cell = 'export const Cell = () => { void fetch("https://api.example.test/rows"); return <b>x</b>; };';
    const message = await attempt(app("connect", cell, ', mcp: { csp: { resourceDomains: ["https://api.example.test"] } }'));
    expect(message).toContain("https://api.example.test/rows");
    expect(message).toContain("connectDomains");
    expect(await attempt(app("connect-declared", cell, ', mcp: { csp: { connectDomains: ["https://api.example.test"] } }'))).toBeUndefined();
  }, 120_000);

  it("does not read an unreadable entry silently: it warns, and fails when the entry declares csp, components, plugins, pages or mcp", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const plain = app("unreadable", "export const Cell = () => <b>x</b>;");
      writeFileSync(plain.entry, `import { defineAdmin } from ${JSON.stringify(resolve(pkg, "dist/admin-app/index.js"))};\nconst where = window.location.href;\nexport default defineAdmin({}, { nav: { items: [] } });`);
      expect(await attempt(plain)).toBeUndefined();
      expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toMatch(/could not be run in Node to read its definition/);
      for (const [name, options] of [["csp", ', mcp: { csp: { resourceDomains: ["https://cdn.example.test"] } }'], ["components", ""]] as const) {
        const declares = app("unreadable-" + name, "export const Cell = () => <b>x</b>;", options);
        writeFileSync(declares.entry, "const where = window.location.href;\n" + readFileSync(declares.entry, "utf8"));
        expect(await attempt(declares)).toMatch(/declares (?:csp|components|mcp), but it could not be run in Node/);
      }
    } finally { warn.mockRestore(); }
  }, 180_000);

  it("warns about an override of a slot the App does not show yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fixture = app("idle", "export const Cell = () => <b>x</b>;");
      writeFileSync(fixture.entry, readFileSync(fixture.entry, "utf8").replace('components: { "cell:view:pending.item": Cell', 'components: { "input:requests.title": () => null, "cell:view:pending.item": Cell'));
      expect(await attempt(fixture)).toBeUndefined();
      expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toContain("input:requests.title is not shown by the App yet");
    } finally { warn.mockRestore(); }
  }, 120_000);

  it("refuses a csp entry that is not an origin", async () => {
    const message = await attempt(app("bad-csp", "export const Cell = () => <b>x</b>;", ', mcp: { csp: { resourceDomains: ["*"] } }'));
    expect(message).toContain('mcp.csp.resourceDomains: "*" is not an origin');
  }, 120_000);

  it("fails a build whose override reads Admin's browser route, naming the module and the slot", async () => {
    const fixture = app("api", 'export const Cell = () => { void fetch("/admin/api/views/pending"); return <b>x</b>; };');
    const message = await attempt(fixture);
    expect(message).toContain("would break in an MCP host");
    expect(message).toContain('"/admin/api"');
    expect(message).toMatch(/src\/cell\.tsx/);
    expect(message).toContain("slot cell:view:pending.item");
    expect(message).toContain("Customising Admin for MCP hosts");
    // the browser's Admin was built, the App was not written
    expect(existsSync(join(fixture.out, "index.html"))).toBe(true);
    expect(existsSync(join(fixture.out, "mcp-app.html"))).toBe(false);
  }, 120_000);

  it("fails a build whose override reads document.cookie", async () => {
    const message = await attempt(app("cookie", "export const Cell = () => <b>{document.cookie}</b>;"));
    expect(message).toContain("document.cookie");
    expect(message).toMatch(/src\/cell\.tsx/);
  }, 120_000);

  it("fails on a remote image the CSP does not declare, and passes once its origin is declared", async () => {
    const cell = 'export const Cell = () => <img alt="" src="https://cdn.example.test/logo.png" />;';
    const message = await attempt(app("remote", cell));
    expect(message).toContain("https://cdn.example.test/logo.png");
    expect(message).toContain("mcp: { csp }");
    expect(message).toMatch(/src\/cell\.tsx/);
    const declaredApp = app("remote-declared", cell, ', mcp: { csp: { resourceDomains: ["https://cdn.example.test"] } }');
    expect(await attempt(declaredApp)).toBeUndefined();
    const built = readFileSync(join(declaredApp.out, "mcp-app.html"), "utf8");
    expect(built).toContain("https://cdn.example.test/logo.png");
    // declared once: the file carries the CSP for the server to send
    expect(JSON.parse(/<meta name="mantle-mcp-csp" content='([^']*)'>/.exec(built)![1]!)).toEqual({ resourceDomains: ["https://cdn.example.test"] });
  }, 120_000);

  it("warns, and builds, when an override calls window.open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fixture = app("open", 'export const Cell = () => <button onClick={() => window.open("https://example.test")}>go</button>;');
      expect(await attempt(fixture)).toBeUndefined();
      expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toMatch(/src\/cell\.tsx: window\.open does nothing/);
      expect(existsSync(join(fixture.out, "mcp-app.html"))).toBe(true);
    } finally { warn.mockRestore(); }
  }, 120_000);
});

describe("checkMcpApp", () => {
  const uses = (code: string) => hitsOf(code).map(hit => hit.rule === "remote" ? `${hit.kind}:${hit.url}` : hit.rule).sort();

  it("finds each rule, in HTML, JSX props, objects, scripts and CSS", () => {
    expect(uses('fetch("/admin/api/me")')).toEqual(["api"]);
    expect(uses("document.cookie = 'a=b'; document['cookie']")).toEqual(["cookie"]);
    expect(uses("window.open(url)")).toEqual(["open"]);
    expect(uses('<a target="_blank">x</a>; {target:"_blank"}')).toEqual(["blank"]);
    expect(uses('<img src="https://a.test/x.png"><link rel="stylesheet" href="//b.test/s.css"> h("img",{src:`https://c.test/y.png`}) h("link",{rel:"icon",href:"https://d.test/i.png"})'))
      .toEqual(["resource://b.test/s.css", "resource:https://a.test/x.png", "resource:https://c.test/y.png", "resource:https://d.test/i.png"]);
    expect(uses("a{background:url(https://d.test/z.png)} b{background:url('//e.test/z.png')} @import url(https://f.test/f.css); @import '//g.test/g.css';"))
      .toEqual(["resource://e.test/z.png", "resource://g.test/g.css", "resource:https://d.test/z.png", "resource:https://f.test/f.css"]);
    // a link's href is navigation, not a load; a namespace or documentation link is not a resource; neither is data: or a local path
    expect(uses('<a href="https://x.test/page">x</a> h("a",{href:"https://y.test"}) h("svg",{xmlns:"http://www.w3.org/2000/svg"}); "https://react.dev/errors/"; <img src="data:image/png;base64,AA"><a href="/admin/c/x">')).toEqual([]);
  });

  it("sorts each remote use to the CSP list it needs", () => {
    expect(uses('<iframe src="https://f.test/x"></iframe>')).toEqual(["frame:https://f.test/x"]);
    expect(uses('h("iframe",{title:"t",src:"https://f.test/x"})')).toEqual(["frame:https://f.test/x"]);
    expect(uses('fetch("https://c.test/a"); new WebSocket("wss://s.test/ws"); new EventSource(`https://e.test/s`); import("https://m.test/m.js")'))
      .toEqual(["connect:https://c.test/a", "connect:https://e.test/s", "connect:https://m.test/m.js", "connect:wss://s.test/ws"]);
    expect(uses('<img srcset="https://a.test/1.png 1x, https://b.test/2.png 2x, /local.png 3x">')).toEqual(["resource:https://a.test/1.png", "resource:https://b.test/2.png"]);
    expect(uses('a{background:image-set("https://i.test/1.png" 1x, "https://i.test/2.png" 2x)}')).toEqual(["resource:https://i.test/1.png", "resource:https://i.test/2.png"]);
    expect(uses('el.setAttribute("src", "https://s.test/a.png"); el.setAttribute("href", "https://h.test/a.css"); el.setAttribute("title", "https://t.test")'))
      .toEqual(["resource:https://h.test/a.css", "resource:https://s.test/a.png"]);
    // a relative fetch or a computed one is not a remote literal
    expect(uses('fetch("/api/x"); fetch(url)')).toEqual([]);
  });

  it("declares origins by scheme, host, port and wildcard, in the list the use needs", () => {
    expect(declared("https://cdn.test/a.png", { resourceDomains: ["https://cdn.test"] })).toBe(true);
    expect(declared("//cdn.test/a.png", { resourceDomains: ["https://cdn.test"] })).toBe(true);
    // the list matters: a resource origin does not allow a request, nor a frame
    expect(declared("https://cdn.test/a", { resourceDomains: ["https://cdn.test"] }, "connect")).toBe(false);
    expect(declared("https://cdn.test/a", { resourceDomains: ["https://cdn.test"] }, "frame")).toBe(false);
    expect(declared("https://cdn.test/a", { connectDomains: ["https://cdn.test"] }, "connect")).toBe(true);
    expect(declared("wss://s.test/ws", { connectDomains: ["wss://s.test"] }, "connect")).toBe(true);
    expect(declared("https://f.test/x", { frameDomains: ["https://f.test"] }, "frame")).toBe(true);
    expect(declared("https://a.cdn.test/a.png", { resourceDomains: ["https://*.cdn.test"] })).toBe(true);
    expect(declared("https://cdn.test/a.png", { resourceDomains: ["https://*.cdn.test"] })).toBe(false);
    expect(declared("http://cdn.test/a.png", { resourceDomains: ["https://cdn.test"] })).toBe(false);
    expect(declared("https://cdn.test:8443/a.png", { resourceDomains: ["https://cdn.test"] })).toBe(false);
    expect(declared("https://cdn.test:8443/a.png", { resourceDomains: ["https://cdn.test:8443"] })).toBe(true);
    expect(declared("https://evilcdn.test/a.png", { resourceDomains: ["https://*.cdn.test", "https://cdn.test"] })).toBe(false);
    expect(declared("https://cdn.test/a.png", undefined)).toBe(false);
  });

  it("validates the declared csp: origins only", () => {
    expect(cspProblems({ resourceDomains: ["https://cdn.test", "https://*.cdn.test:8443"], connectDomains: ["wss://s.test"] })).toEqual([]);
    expect(cspProblems({ resourceDomains: ["*", "https:", "https://cdn.test/path", "cdn.test"], frameDomains: ["https://*"] })).toHaveLength(5);
  });

  it("names the modules and slots of what it refuses, and warns only about the application's own code", () => {
    const { errors, warnings } = checkMcpApp('fetch("/admin/api/x"); window.open(a)', undefined, [
      { module: "/app/src/cell.tsx", hits: [{ rule: "api" }, { rule: "open" }] },
      { slot: "Home", hits: [{ rule: "api" }] },
      { module: "/lib/admin-app/mcp-mount.js", hits: [{ rule: "open" }] },
      { module: "/app/node_modules/x/index.js", hits: [{ rule: "open" }] },
    ], { libraries: ["/lib/admin-app"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("in /app/src/cell.tsx (slot Home)");
    expect(warnings).toEqual(["/app/src/cell.tsx: window.open does nothing in a host's sandbox. Use <AdminLink> or useOpenLink()."]);
  });

  it("lets Mantle's own library write a cookie but not the application's code", () => {
    const libraries = ["/lib/kit"];
    expect(checkMcpApp("document.cookie = 'x'", undefined, [{ module: "/lib/kit/sidebar.js", hits: [{ rule: "cookie" }] }], { libraries }).errors).toEqual([]);
    expect(checkMcpApp("document.cookie = 'x'", undefined, [{ module: "/lib/kit/sidebar.js", hits: [{ rule: "cookie" }] }, { module: "/app/src/c.tsx", hits: [{ rule: "cookie" }] }], { libraries }).errors).toHaveLength(1);
    // a hit nothing names is the application's until shown otherwise
    expect(checkMcpApp("document.cookie = 'x'", undefined, [], { libraries }).errors).toHaveLength(1);
  });
});
