// Builds the /app single-page app (src/spa) into dist/client/assets/spa.js, where the edge serves /assets/* without running
// the Worker. `mantle bundle` builds only the Worker and Admin and copies public/ (public/app/index.html is the shell), and
// `mantle generate` owns wrangler.jsonc's build command, so an app's own browser code is a separate step: run
// `node build-spa.mjs` before `pnpm dev` and `wrangler deploy` (`pnpm smoke` runs it itself).
import { build } from "esbuild";

await build({
  entryPoints: ["src/spa/main.tsx"],
  outfile: "dist/client/assets/spa.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
