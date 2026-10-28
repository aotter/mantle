# Size and startup

The SDK ships kernel, CLI, generator and private compiler together. Request modules do not import compiler code. Import only selected generated operations and bindings; direct operations can omit Store/Admin/auth entirely.

Workers use `mantle bundle` to emit split ESM. Keep Better Auth behind `authLoader(() => import(...))`; the startup graph guard rejects eager auth imports, and Admin's browser code (`@aotter/mantle-admin/app`, `/hooks`, and so `generated/admin-client.ts`): import those only from `admin.tsx`, which `mantle bundle` builds into the assets directory. The official MCP SDK and selected Admin operations load on matching requests. Generated module imports perform no SQL or kernel initialization; Store metadata initializes on first use without SQL.

Contributor checks use tracked fixtures to compare runtime/startup graphs against `size-budgets.json` and inspect the published allowlist in `check:package`. Package packed/unpacked bytes are reported separately from request startup and query costs. Do not infer latency from bundle bytes.

Cloudflare startup_time_ms needs an actual upload/deployment; offline dry runs do not measure it. Measure on the selected host and report first use and warm work separately. Applications own deployment authorization and resources.

## Size metrics

Three metrics, one definition each. The [performance skill](../../skills/performance/SKILL.md)
and the SDK's own checks use these names. Measure the production build that
`mantle bundle` writes, never a dev server.

"gzip per file" means: compress each file on its own with Node's `zlib.gzipSync`
at its default level, then add the results. A host may serve Brotli or another
level; that is a different number, so name it when you report it.

| Metric | What counts | Unit |
|---|---|---|
| First-load JavaScript | Every script a page's HTML loads (classic `<script src>` and `type="module"` entries), plus every file they import statically, recursively. A dynamic `import()` is not followed. CSS, fonts and images do not count. | gzip per file |
| MCP App HTML document | The whole built App document as served: its inline JavaScript, CSS and markup in one file. | raw bytes and gzip of the file |
| Worker entry static graph | The Worker entry (Wrangler's `main`, such as `dist/worker/worker.js`) plus every chunk it imports statically, recursively. A dynamic `import()` is not followed. | gzip per file; raw bytes beside it |

The 100 KB budget in the performance skill is first-load JavaScript. The MCP App
HTML document also holds CSS and markup, so do not compare it with that budget.

### Measure the static graphs

This script follows static imports in the minified ESM that Vite and
`mantle bundle` emit. It reproduces the SDK checks' graphs below. Save it outside
`src/`:

```js
// static-graph.mjs — node static-graph.mjs <entry.js>...
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const seen = new Set();
let raw = 0, gzip = 0;
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const code = readFileSync(file);
  raw += code.length;
  gzip += gzipSync(code).length;
  // `import … from "./x.js"`, `import "./x.js"`, `export … from "./x.js"`; a dynamic `import("./x.js")` is not followed.
  const imports = /(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{},\s]*?from\s*)?["'](\.{1,2}\/[^"']+)["']/g;
  for (const [, path] of code.toString().matchAll(imports)) visit(resolve(dirname(file), path));
}
for (const entry of process.argv.slice(2)) visit(resolve(entry));
console.log(JSON.stringify({ files: seen.size, raw, gzip }));
```

First-load JavaScript of a page: pass every script its HTML loads. For built-in
Admin, that is the blocking `theme.js` and the module entry:

```sh
pnpm exec mantle bundle src/worker.ts dist
node static-graph.mjs dist/client/admin/theme.js dist/client/admin/assets/index-*.js
```

Worker entry static graph: pass Wrangler's `main`:

```sh
node static-graph.mjs dist/worker/worker.js
```

### Measure the MCP App HTML document

```sh
node -e 'const b=require("fs").readFileSync(process.argv[1]);console.log(JSON.stringify({raw:b.length,gzip:require("zlib").gzipSync(b).length}))' dist/client/admin/mcp-app.html
```

## What the SDK's checks measure

The SDK's own checks run on fixtures and the built-in Admin entry, not on your
application. Where they differ from the definitions above:

| Check | Reports | Difference |
|---|---|---|
| `check:ui-size`, `admin:entry-gzip` | Admin's module entry and its static graph, gzip per file | Leaves out the blocking classic `theme.js` (about 0.8 KB gzip). Reported, not gating. |
| `check:ui-size`, `admin:mcp-html` | Raw bytes of `mcp-app.html` | No gzip figure. Reported, not gating. |
| `check:startup` and `check-size.ts`, `startup:<surface>` and `startupBytes` | The Worker entry's static graph from esbuild's metafile | Raw minified bytes, not gzip. `startup:<surface>` gates fixture Workers against `size-budgets.json`. |
| `check-size.ts`, `gzipBytes` | Every `.js` file of a fixture Worker bundle, gzip per file | Includes lazy chunks, so it is the whole bundle, not the static graph. |

`check:ui-size` also gates that lazy features and locales stay out of Admin's
startup graph, and `check:startup` runs it with `--startup-only`. Package bytes
(`packed`, `unpacked`) are a separate measure of what installs.

## Native Admin baselines

Built-in Admin is SDK-existing cost. Its size is tracked in
[#1554](https://github.com/aotter/mantle/issues/1554). Measured with the
commands above on the built-in entry:

| SDK | First-load JavaScript | MCP App HTML document |
|---|---|---|
| 0.2.1 | 212,102 B gzip in 5 files (211,338 B without `theme.js`) | 694,170 B raw / 200,457 B gzip |

The MCP App document's inline JavaScript alone is about 193.5 KB gzip, so the
built-in App does not meet the 100 KB first-load budget. That miss belongs to
#1554, not to your application.

## Report size

- Report app-added cost and SDK-existing cost separately. App-added cost is your
  measurement minus the baseline for the installed SDK version.
- When the installed SDK and Admin versions are unchanged and Admin uses the
  built-in entry, the baseline still holds: do not repeat that experiment each
  round. An `admin.tsx` entry or a custom MCP App changes what you measure.
- A target still missed is PARTIAL, even when the SDK's cost causes it. Never
  relabel PARTIAL as PASS and never raise a threshold to pass.
- Do not patch vendor or SDK code, remove native Admin features or build a
  general benchmark framework to pass. Report the miss and its owner.
