#!/usr/bin/env node
/** Actual publication bytes and startup assets; this check never changes a budget. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "mantle-ui-size-"));
const startupOnly = process.argv.includes("--startup-only");
const selection = startupOnly ? "mantle-admin" : process.argv[2] ?? "all";
if (!["all", "mantle-ui", "mantle-admin"].includes(selection)) throw new Error("Expected all, mantle-ui or mantle-admin");
const measured = {};
const failures = [];
try {
  for (const name of startupOnly ? [] : selection === "all" ? ["mantle-ui", "mantle-admin"] : [selection]) {
    const dir = join(root, "packages", name);
    execFileSync("pnpm", ["pack", "--pack-destination", temp], { cwd: dir, stdio: "pipe" });
    const file = readdirSync(temp).find(file => file.startsWith(`aotter-${name}-`) && file.endsWith(".tgz"));
    if (!file) throw new Error(`pnpm did not pack ${name}`);
    const packed = readFileSync(join(temp, file));
    const tar = gunzipSync(packed);
    let unpacked = 0;
    for (let offset = 0; offset + 512 <= tar.length && tar[offset];) {
      const header = tar.subarray(offset, offset + 512);
      const size = parseInt(header.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim(), 8) || 0;
      if ([0, 48].includes(header[156])) {
        unpacked += size;
        const path = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
        if (path.endsWith(".map")) failures.push(`${name} publishes source map ${path}`);
        if (name === "mantle-ui" && /\/dist\/(?:admin|mcp-app|extension|admin-preview|app)\//.test(path)) failures.push(`pure UI publishes ${path}`);
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    measured[`${name}:packed`] = packed.length;
    measured[`${name}:unpacked`] = unpacked;
  }
  if (selection !== "mantle-ui") {
  // An application's Admin as `mantle bundle` builds it with the built-in entry.
  const admin = join(temp, "admin");
  await (await import(join(root, "packages/mantle-admin/dist/build/index.js"))).buildAdmin({ outDir: admin });
  const html = readFileSync(join(admin, "index.html"), "utf8");
  const entry = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
  if (!entry) throw new Error("Admin entry module is missing");
  const visited = new Set();
  // Vite's default eight-character hash, twice when a locale is built from a hashed library chunk (`ar-<hash>-<hash>.js`):
  // `id-value-<hash>` is a UI component, not the `id` locale.
  const deferredLanguage = /\/(?:ar|cs|de|es|fa|fr|he|id|it|ja|ko|nl|pl|pt-BR|ru|th|tr|uk|vi|zh-CN|zh-TW)-[\w-]{8}(?:-[\w-]{8})?\.js$/;
  // the guard must see the locales, or it would pass whatever reaches startup
  if (!readdirSync(join(admin, "assets")).some(file => deferredLanguage.test(`/${file}`))) failures.push("no lazy locale chunk matches the startup guard's pattern");
  function startup(path) {
    path = resolve(path);
    if (visited.has(path)) return 0;
    visited.add(path);
    const code = readFileSync(path, "utf8");
    if (/html-editor|markdown-editor|developer-workspace/.test(path) || deferredLanguage.test(path)) failures.push(`lazy feature is in startup: ${path}`);
    const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let bytes = gzipSync(code).length;
    for (const node of source.statements) if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith(".")) bytes += startup(resolve(path, "..", spec));
    }
    return bytes;
  }
  // Count the whole static entry graph so a facade cannot conceal startup bytes.
  measured["admin:entry-gzip"] = startup(resolve(admin, entry));
  if (!startupOnly) {
    const app = await import(join(root, "packages/mantle-admin/dist/mcp-app/index.js"));
    measured["admin:mcp-html"] = Buffer.byteLength(app.mantleAppHtml);
    if (readdirSync(join(root, "packages/mantle-admin/dist/mcp-app")).some(file => file.endsWith(".html"))) failures.push("MCP App HTML is shipped twice");
  }
  }
  console.log(JSON.stringify(measured, null, 2));
  const budgets = JSON.parse(readFileSync(join(root, "ui-size-budgets.json"), "utf8"));
  for (const [name, bytes] of Object.entries(measured)) {
    if (!Number.isSafeInteger(budgets[name])) failures.push(`missing fixed budget: ${name}`);
    // Bytes are reported, not gating (#1465, 2026-10-13): Worker cold start is gated by check-size.ts startup graphs.
    else if (bytes > budgets[name]) console.warn(`[size report] ${name}: ${bytes} exceeds the reference ${budgets[name]}`);
  }
  if (failures.length) throw new Error(failures.join("\n"));
} finally { rmSync(temp, { recursive: true, force: true }); }
