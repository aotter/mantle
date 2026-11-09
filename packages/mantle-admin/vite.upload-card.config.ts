import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** The card's look: the host's MCP Apps style variables where it sets them, plain system defaults otherwise. */
const STYLE = `:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,CanvasText);background:var(--color-background-primary,Canvas)}
body{margin:0}form{display:grid;gap:.75rem;padding:1rem;max-width:32rem}h1{font-size:1rem;margin:0}label{display:grid;gap:.25rem;font-size:.875rem}
input,select,button{font:inherit}button{justify-self:start;padding:.375rem .875rem;border-radius:var(--border-radius-md,.375rem);border:1px solid var(--color-border-primary,currentColor);background:transparent;color:inherit;cursor:pointer}
[hidden]{display:none!important}button:disabled{opacity:.5;cursor:default}progress{width:100%}[role=alert]{color:var(--color-text-danger,#b42318)}p{margin:0;font-size:.875rem;overflow-wrap:anywhere}`;

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
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Upload media</title><style>${STYLE}</style></head><body><script>${script}</script></body></html>`;
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
