import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * The card's look: the host's MCP Apps style variables where it sets them, plain system defaults otherwise. No background:
 * the conversation shows through. On a touch screen a control is at least 44 px tall (Claude's tap target).
 */
const STYLE = `:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,CanvasText)}
html,body{margin:0;background:transparent}*{box-sizing:border-box}form{display:grid;gap:.75rem;padding:1.25rem;max-width:36rem;margin:auto}header{display:grid;gap:.375rem}h1{font-size:1.25rem;font-weight:600;letter-spacing:-.02em;margin:0}label{display:grid;gap:.375rem;font-size:.875rem;font-weight:500}
input,select,button{font:inherit;color:inherit}input[type=text],select{min-height:2.75rem;padding:.625rem .75rem;background:var(--color-background-primary,Canvas);border:1px solid var(--color-border-primary,GrayText);border-radius:var(--border-radius-md,.5rem);min-width:0;width:100%}.file-picker{padding:1rem;border:1px dashed var(--color-border-primary,GrayText);border-radius:var(--border-radius-lg,.75rem);background:var(--color-background-secondary,transparent)}input[type=file]{width:100%;min-width:0;font-weight:400;font-size:.8125rem}input[type=file]::file-selector-button{font:inherit;color:inherit;padding:.5rem .75rem;border:1px solid var(--color-border-primary,GrayText);border-radius:.375rem;background:var(--color-background-primary,Canvas);margin-right:.75rem;cursor:pointer}button{min-height:2.75rem;padding:.625rem 1rem;border-radius:var(--border-radius-md,.5rem);border:1px solid var(--color-border-primary,GrayText);background:var(--color-background-primary,Canvas);color:inherit;cursor:pointer;font-weight:600}button:enabled:hover{background:var(--color-background-secondary,ButtonFace)}:focus-visible{outline:2px solid var(--color-text-info,Highlight);outline-offset:3px}
[hidden]{display:none!important}button:disabled{opacity:.5;cursor:default}progress{width:100%;height:.5rem;accent-color:var(--color-text-info,Highlight)}[role=alert]{color:var(--color-text-danger,#b42318);padding:.75rem;border:1px solid currentColor;border-radius:.5rem}p{margin:0;font-size:.875rem;line-height:1.5;overflow-wrap:anywhere}.eyebrow{font-size:.6875rem;letter-spacing:.1em;text-transform:uppercase;color:var(--color-text-secondary,GrayText)}.hint{font-size:.8125rem;color:var(--color-text-secondary,GrayText)}.file-details{font-size:.8125rem}form[data-asset] #status{padding:.75rem;border-radius:.5rem;background:var(--color-background-success,transparent);color:var(--color-text-success,CanvasText)}@media(max-width:360px){form{padding:.875rem}}`;

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
