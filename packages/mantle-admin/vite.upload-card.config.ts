import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * The card's look: the host's MCP Apps style variables where it sets them, plain system defaults otherwise. No background:
 * the conversation shows through. On a touch screen a control is at least 44 px tall (Claude's tap target).
 */
const STYLE = `
:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,CanvasText);font-synthesis:none}
html,body{margin:0;background:transparent}*{box-sizing:border-box}
form{display:grid;gap:1rem;padding:1.5rem;max-width:32rem;margin:auto}
header{display:flex;align-items:center;gap:.875rem}header div{display:grid;gap:.25rem;min-width:0}
.upload-icon{display:grid;place-items:center;width:2.75rem;height:2.75rem;flex:none;border-radius:.875rem;background:var(--color-background-secondary,color-mix(in srgb,CanvasText 6%,Canvas))}
.upload-icon svg{width:1.5rem;height:1.5rem}
h1{font-size:1.25rem;line-height:1.25;font-weight:650;letter-spacing:-.025em;margin:0}
label{display:grid;gap:.5rem;font-size:.875rem;font-weight:550;min-width:0}
input,select,button{font:inherit;color:inherit}
input[type=text],select{min-height:2.75rem;padding:.625rem .75rem;background:var(--color-background-primary,Canvas);border:1px solid var(--color-border-primary,color-mix(in srgb,CanvasText 18%,Canvas));border-radius:.625rem;min-width:0;width:100%}
.file-panel{display:grid;gap:.75rem;padding:1rem;border:1px solid var(--color-border-primary,color-mix(in srgb,CanvasText 15%,Canvas));border-radius:.875rem;background:var(--color-background-secondary,color-mix(in srgb,CanvasText 3%,Canvas))}
.file-picker{gap:.625rem}input[type=file]{width:100%;min-width:0;font-weight:400;font-size:.8125rem;line-height:1.5}
input[type=file]::file-selector-button{font:inherit;font-weight:550;color:inherit;min-height:2.75rem;padding:.625rem .875rem;border:1px solid var(--color-border-primary,color-mix(in srgb,CanvasText 18%,Canvas));border-radius:.625rem;background:var(--color-background-primary,Canvas);margin-right:.75rem;cursor:pointer}
button{min-height:2.875rem;padding:.75rem 1rem;border-radius:.625rem;border:1px solid transparent;background:var(--color-text-primary,CanvasText);color:var(--color-background-primary,Canvas);cursor:pointer;font-weight:600;transition:opacity .15s}
button:enabled:hover{opacity:.85}button:disabled{opacity:.35;cursor:default}
input:disabled,select:disabled{opacity:.6}input[type=file]:disabled::file-selector-button{cursor:default}
:focus-visible{outline:2px solid var(--color-text-info,Highlight);outline-offset:3px}
[hidden]{display:none!important}progress{width:100%;height:.375rem;border:0;border-radius:1rem;overflow:hidden;accent-color:var(--color-text-primary,CanvasText)}
progress::-webkit-progress-bar{background:var(--color-background-secondary,color-mix(in srgb,CanvasText 12%,Canvas))}progress::-webkit-progress-value{background:var(--color-text-primary,CanvasText);border-radius:1rem}
p{margin:0;font-size:.875rem;line-height:1.5;overflow-wrap:anywhere}
.eyebrow{font-size:.6875rem;font-weight:550;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-secondary,color-mix(in srgb,CanvasText 65%,Canvas))}
.hint{font-size:.8125rem;font-weight:400;color:var(--color-text-secondary,color-mix(in srgb,CanvasText 65%,Canvas))}
.file-details{font-size:.8125rem;font-weight:550}.footnote{font-size:.75rem;text-align:center;color:var(--color-text-secondary,color-mix(in srgb,CanvasText 65%,Canvas))}
#status:empty{display:none}[role=alert]{color:var(--color-text-danger,light-dark(#b42318,#ffaaa3));padding:.875rem;border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:.625rem;background:color-mix(in srgb,currentColor 5%,transparent)}
form[data-asset] #status{padding:.875rem;border-radius:.625rem;background:var(--color-background-success,light-dark(#effaf3,#152e22));color:var(--color-text-success,light-dark(#17663a,#9bdfb6))}form[data-asset] .footnote{display:none}
@media(max-width:360px){form{padding:1rem;gap:.875rem}.file-panel{padding:.875rem}}
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
