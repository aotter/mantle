# Size and startup

The SDK ships kernel, CLI, generator and private compiler together. Request modules do not import compiler code. Import only selected generated operations and bindings; direct operations can omit Store/Admin/auth entirely.

Workers use `mantle bundle` to emit split ESM. Keep Better Auth behind `authLoader(() => import(...))`; the startup graph guard rejects eager auth imports, and Admin's browser code (`@aotter/mantle-admin/app`, `/hooks`, and so `generated/admin-client.ts`): import those only from `admin.tsx`, which `mantle bundle` builds into the assets directory. The official MCP SDK and selected Admin operations load on matching requests. Generated module imports perform no SQL or kernel initialization; Store metadata initializes on first use without SQL.

Contributor checks use tracked fixtures to compare runtime/startup graphs against `size-budgets.json` and inspect the published allowlist in `check:package`. Package packed/unpacked bytes are reported separately from request startup and query costs. Do not infer latency from bundle bytes.

Cloudflare startup_time_ms needs an actual upload/deployment; offline dry runs do not measure it. Measure on the selected host and report first use and warm work separately. Applications own deployment authorization and resources.

## Size metrics

Three metrics, one definition each. The [performance pass](performance.md)
and the SDK's own checks use these names. Measure the production build that
`mantle bundle` writes, never a dev server.

"gzip per file" means: compress each file, or each inline script, on its own with
Node's `zlib.gzipSync` at its default level, then add the results. A host may
serve Brotli or another level; that is a different number, so name it when you
report it.

| Metric | What counts | Unit |
|---|---|---|
| First-load JavaScript | Every script a page's HTML loads: `<script src>` files and inline `<script>` text, classic or `type="module"`, plus every file they import statically, recursively. A dynamic `import()` is not followed. CSS, fonts, images and scripts from another origin do not count. | gzip per file |
| MCP App HTML document | The whole built App document as served: its inline JavaScript, CSS and markup in one file. | raw bytes and gzip of the file |
| Worker entry static graph | The Worker entry (Wrangler's `main`, such as `dist/worker/worker.js`) plus every chunk it imports statically, recursively. A dynamic `import()` is not followed. | gzip per file; raw bytes beside it |

The 100 KB budget in the [performance pass](performance.md) is first-load JavaScript. It applies to
an MCP App too: `mantle bundle` builds the App as one HTML file with its
JavaScript inline, so its first-load JavaScript is its inline script text. The
MCP App HTML document also holds CSS and markup, so do not compare the document
with that budget.

### Measure

This script measures first-load JavaScript and the Worker entry static graph. It
follows static imports in the minified ESM that Vite and `mantle bundle` emit,
and reproduces the SDK checks' graphs below. Save it outside `src/`:

```js
// first-load.mjs — node first-load.mjs <page.html | entry.js> [assets-directory]
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const [target, root = dirname(target)] = process.argv.slice(2);
const seen = new Set();
let scripts = 0, raw = 0, gzip = 0;
// `import … from "./x.js"`, `import "./x.js"`, `export … from "./x.js"`; a dynamic `import("./x.js")` is not followed.
const imports = /(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{},\s]*?from\s*)?["'](\.{1,2}\/[^"']+)["']/g;
function count(code, directory) {
  scripts += 1;
  raw += code.length;
  gzip += gzipSync(code).length;
  for (const [, path] of code.toString().matchAll(imports)) visit(resolve(directory, path));
}
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  count(readFileSync(file), dirname(file));
}
if (target.endsWith(".html")) {
  // Every script the page loads: `<script src>` files and inline `<script>` text, classic or module.
  const html = readFileSync(target, "utf8");
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const type = /\btype="([^"]*)"/i.exec(attributes)?.[1] ?? "";
    if (!["", "module", "text/javascript"].includes(type)) continue; // JSON data and import maps are not JavaScript
    const src = /\bsrc="([^"]+)"/i.exec(attributes)?.[1];
    if (!src) count(Buffer.from(body), dirname(resolve(target)));
    else if (!/^(?:[a-z]+:)?\/\//i.test(src)) visit(src.startsWith("/") ? join(resolve(root), src) : resolve(dirname(target), src));
  }
} else visit(resolve(target));
console.log(JSON.stringify({ scripts, raw, gzip }));
```

First-load JavaScript of a page: pass its HTML, and the assets directory when the
page loads scripts by absolute path. Built-in Admin loads the blocking `theme.js`
and the module entry:

```sh
pnpm exec mantle bundle src/worker.ts dist
node first-load.mjs dist/client/admin/index.html dist/client
```

First-load JavaScript of an MCP App: pass its HTML document.

```sh
node first-load.mjs dist/client/admin/mcp-app.html
```

Worker entry static graph: pass Wrangler's `main`.

```sh
node first-load.mjs dist/worker/worker.js
```

MCP App HTML document:

```sh
node -e 'const b=require("fs").readFileSync(process.argv[1]);console.log(JSON.stringify({raw:b.length,gzip:require("zlib").gzipSync(b).length}))' dist/client/admin/mcp-app.html
```

## What the SDK's checks measure

The SDK's own checks run on fixtures and the built-in Admin entry, not on your
application. Where they differ from the definitions above:

| Check | Reports | Difference |
|---|---|---|
| `check:ui-size`, `admin:entry-gzip` | Admin's module entry and its static graph, gzip per file | Leaves out the blocking classic `theme.js` (about 0.8 KB gzip). Reported, not gating. |
| `check:ui-size`, `admin:mcp-html` | Raw bytes of `mcp-app.html` | No gzip figure and no inline JavaScript figure. Reported, not gating. |
| `check:startup` and `check-size.ts`, `startup:<surface>` | The static graph of a fixture Worker mounting each surface, from esbuild's metafile | Raw minified bytes, not gzip. Gates against `size-budgets.json`. |
| `check-size.ts`, `direct-op` | The static graph of one direct operation import | Raw minified bytes. Gates below 4 KiB. |
| `check-size.ts`, `startupBytes` of `cloudflare-d1` and `cloudflare-postgres` | The fixture Worker entry's static graph | Raw minified bytes. Reported, not gating. |
| `check-size.ts`, `totalBytes` and `gzipBytes` | Every `.js` file of a fixture Worker bundle; `gzipBytes` is gzip per file | Includes lazy chunks, so it is the whole bundle, not the static graph. Only `totalBytes` warns above its reference; neither gates. |

`check:ui-size` also gates that lazy features and locales stay out of Admin's
startup graph, and `check:startup` runs it with `--startup-only`. Package bytes
(`packed`, `unpacked`) are a separate measure of what installs.

## Native Admin baselines

Built-in Admin is SDK-existing cost: both its page and its MCP App. The 0.2.0
size pass, [#1554](https://github.com/aotter/mantle/issues/1554), shrank them and
is closed; the misses below are what remains. Measured with the commands above on
the built-in entry. The figures move with any change to Admin or its
dependencies, so they hold only for the version and commit named.

| SDK | Source | Admin page first-load JavaScript | MCP App first-load JavaScript | MCP App HTML document |
|---|---|---|---|---|
| 0.2.1 | `develop` at `6dafb812`, before the release | 212,102 B gzip in 5 files (211,338 B without `theme.js`) | 193,535 B gzip, inline | 694,170 B raw / 200,457 B gzip |

Neither the built-in Admin page nor its MCP App meets the 100 KB first-load
budget. Both misses are SDK cost, not your application's: report them as
SDK-existing, link #1554, and keep them out of app-added cost.

## Report size

- Report app-added cost and SDK-existing cost separately. App-added cost is your
  measurement minus the baseline for the installed SDK version. When your figures
  for an unchanged built-in Admin differ from the table, measure the baseline
  again on your install and subtract that.
- When the installed SDK and Admin versions are unchanged and Admin uses the
  built-in entry, the baseline still holds: do not repeat that experiment each
  round. An `admin.tsx` entry or a custom MCP App changes what you measure.
- A target still missed is PARTIAL, even when the SDK's cost causes it. Never
  relabel PARTIAL as PASS and never raise a threshold to pass.
- Do not patch vendor or SDK code, remove native Admin features or build a
  general benchmark framework to pass. Report the miss and its owner.
