import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
const entries = (await readdir("src", { recursive: true })).filter(file => file.endsWith(".ts"));
await build({
  entryPoints: entries.map(file => resolve("src", file)), outdir: "dist", outbase: "src",
  bundle: false, minify: false, format: "esm", platform: "neutral", target: "es2022",
});
