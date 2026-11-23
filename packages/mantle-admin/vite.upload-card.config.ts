import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";

/** The shared UI tokens supply the brand; MCP host variables supply neutral surfaces and text. */
const tokens = readFileSync(createRequire(import.meta.url).resolve("@aotter/mantle-ui/tokens.css"), "utf8");
const STYLE = `${tokens}
:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,var(--foreground));font-synthesis:none}
html,body{margin:0;background:transparent}*{box-sizing:border-box}
form{display:grid;gap:1.25rem;padding:1.5rem;max-width:32rem;margin:auto}
header{display:grid;gap:.375rem}
h1{font-size:1.25rem;line-height:1.3;font-weight:600;letter-spacing:-.025em;margin:0}
label{display:grid;gap:.5rem;font-size:.875rem;font-weight:500;min-width:0}
input,select,button{font:inherit;color:inherit}
input[type=text],select{min-height:2.75rem;padding:.625rem .75rem;background:var(--color-background-primary,var(--background));border:1px solid var(--color-border-primary,var(--input));border-radius:var(--radius);min-width:0;width:100%}
.file-panel{display:grid;gap:.75rem;padding:1.25rem;border:1px dashed var(--color-border-primary,var(--border));border-radius:calc(var(--radius) + 4px);background:var(--color-background-secondary,var(--muted))}
.file-picker{position:relative;justify-items:center;gap:.625rem;text-align:center;cursor:pointer;padding:.5rem;overflow:hidden;border-radius:var(--radius)}
.file-picker:hover{background:color-mix(in srgb,var(--primary) 5%,transparent)}
.file-picker:focus-within{outline:2px solid var(--color-ring-primary,var(--ring));outline-offset:3px}
.file-picker input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
.file-picker:has(input:disabled){opacity:.6;cursor:default}.file-picker input:disabled{cursor:default}
.file-icon{display:grid;place-items:center;width:2.5rem;height:2.5rem;border:1px solid var(--color-border-primary,var(--border));border-radius:var(--radius);background:var(--color-background-primary,var(--card));color:var(--color-text-secondary,var(--muted-foreground))}
.file-icon svg{width:1.25rem;height:1.25rem}
.picker-title{font-size:.875rem;font-weight:600}.file-details{font-size:.8125rem;text-align:center}
.actions{display:flex;justify-content:flex-end}
button{min-height:2.75rem;min-width:7.5rem;padding:.625rem 1.125rem;border-radius:var(--radius);border:1px solid transparent;background:var(--primary);color:var(--primary-foreground);cursor:pointer;font-weight:500;font-size:.875rem;transition:opacity .15s}
button:enabled:hover{opacity:.85}button:disabled{opacity:.5;cursor:default}
input:disabled,select:disabled{opacity:.6}
:focus-visible{outline:2px solid var(--color-ring-primary,var(--ring));outline-offset:3px}
[hidden]{display:none!important}progress{width:100%;height:.375rem;border:0;border-radius:1rem;overflow:hidden;accent-color:var(--primary)}
progress::-webkit-progress-bar{background:var(--color-background-secondary,var(--muted))}progress::-webkit-progress-value{background:var(--primary);border-radius:1rem}
p{margin:0;font-size:.875rem;line-height:1.5;overflow-wrap:anywhere}
.eyebrow{font-size:.6875rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-secondary,var(--muted-foreground))}
.hint{font-size:.8125rem;font-weight:400;color:var(--color-text-secondary,var(--muted-foreground))}
#policy{text-align:center}.footnote{font-size:.75rem;color:var(--color-text-secondary,var(--muted-foreground))}
#status:empty{display:none}[role=alert]{color:var(--color-text-danger,var(--destructive));padding:.875rem;border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:var(--radius);background:color-mix(in srgb,currentColor 5%,transparent)}
form[data-asset] #status{padding:.875rem;border-radius:var(--radius);background:var(--color-background-success,light-dark(#effaf3,#152e22));color:var(--color-text-success,light-dark(#17663a,#9bdfb6))}form[data-asset] .footnote{display:none}
@media(max-width:360px){form{padding:1rem;gap:1rem}.file-panel{padding:.875rem}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
`;

/**
 * The upload card `mediaUploadCard` serves: one self-contained HTML page, written over the placeholder `tsc` emitted as
 * `dist/server/upload-card.js`, so a Worker loads it with a dynamic import and no asset binding.
 */
function htmlModule(): Plugin {
  return {
    name: "upload-card-html",
    generateBundle(_options, bundle) {
      const [name, chunk] = Object.entries(bundle).find(([, output]) => output.type === "chunk")!;
      if (chunk.type !== "chunk") return;
      delete bundle[name];
      const script = chunk.code.replace(/<\/(script)/gi, "<\\/$1");
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Upload media</title><style>${STYLE}</style></head><body><script>${script}</script></body></html>`;
      this.emitFile({ type: "asset", fileName: "upload-card.js", source: `export default ${JSON.stringify(html)};\n` });
    },
  };
}

export default defineConfig({
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [htmlModule()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/server"), emptyOutDir: false, copyPublicDir: false,
    lib: { entry: resolve(import.meta.dirname, "admin/src/mcp-app/upload-card.ts"), formats: ["iife"], name: "MantleUploadCard", fileName: () => "upload-card-bundle.js" },
  },
});
