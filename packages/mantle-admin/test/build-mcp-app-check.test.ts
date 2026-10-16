import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkMcpApp, declared, hitsOf } from "../src/build/mcp-check.js";

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
  it("finds each rule, in HTML, JSX props, objects and CSS", () => {
    const rules = (code: string) => hitsOf(code).map(hit => hit.rule === "remote" ? hit.url : hit.rule);
    expect(rules('fetch("/admin/api/me")')).toEqual(["api"]);
    expect(rules("document.cookie = 'a=b'; document['cookie']")).toEqual(["cookie"]);
    expect(rules("window.open(url)")).toEqual(["open"]);
    expect(rules('<a target="_blank">x</a>; {target:"_blank"}')).toEqual(["blank"]);
    expect(rules('<img src="https://a.test/x.png"><link href="//b.test/s.css"> h("img",{src:`https://c.test/y.png`})')).toEqual(["https://a.test/x.png", "//b.test/s.css", "https://c.test/y.png"]);
    expect(rules("a{background:url(https://d.test/z.png)} b{background:url('//e.test/z.png')} @import url(https://f.test/f.css); @import '//g.test/g.css';"))
      .toEqual(["https://d.test/z.png", "//e.test/z.png", "https://f.test/f.css", "//g.test/g.css"]);
    // a namespace or a documentation link is not a resource; neither is a data: URL or a local path
    expect(rules('h("svg",{xmlns:"http://www.w3.org/2000/svg"}); "https://react.dev/errors/"; <img src="data:image/png;base64,AA"><a href="/admin/c/x">')).toEqual([]);
  });

  it("declares origins by host, scheme, port and wildcard, across the typed lists", () => {
    expect(declared("https://cdn.test/a.png", { resourceDomains: ["https://cdn.test"] })).toBe(true);
    expect(declared("//cdn.test/a.png", { resourceDomains: ["cdn.test"] })).toBe(true);
    expect(declared("https://cdn.test/a.png", { connectDomains: ["https://cdn.test"] })).toBe(true);
    expect(declared("https://a.cdn.test/a.png", { resourceDomains: ["https://*.cdn.test"] })).toBe(true);
    expect(declared("https://cdn.test/a.png", { resourceDomains: ["https://*.cdn.test"] })).toBe(false);
    expect(declared("http://cdn.test/a.png", { resourceDomains: ["https://cdn.test"] })).toBe(false);
    expect(declared("https://cdn.test:8443/a.png", { resourceDomains: ["https://cdn.test"] })).toBe(false);
    expect(declared("https://cdn.test:8443/a.png", { resourceDomains: ["https://cdn.test:8443"] })).toBe(true);
    expect(declared("https://evilcdn.test/a.png", { resourceDomains: ["https://*.cdn.test", "https://cdn.test"] })).toBe(false);
    expect(declared("https://cdn.test/a.png", undefined)).toBe(false);
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
});
