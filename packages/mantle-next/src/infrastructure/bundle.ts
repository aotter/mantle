import { realpathSync, rmSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { build, type Metafile } from "esbuild";

const LAZY_PACKAGES = ["better-auth", "@better-auth/*"] as const;

/** Only static imports run at startup; dynamic imports remain separate uploaded modules. */
export function guardStartup(metafile: Metafile, entry: string): void {
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const output = metafile.outputs[name]!;
    for (const input of Object.keys(output.inputs)) {
      // ponytail: package identity comes from the node_modules path; a vendored copy outside node_modules is not recognized.
      const module = input.replaceAll("\\", "/").split("node_modules/").pop()!;
      if (LAZY_PACKAGES.some(pkg => pkg.endsWith("/*") ? module.startsWith(pkg.slice(0, -1)) : module === pkg || module.startsWith(`${pkg}/`))) {
        throw new Error(`Startup module ${name} contains ${input}. Load it through authLoader(() => import(...)) to keep Better Auth out of startup.`);
      }
    }
    for (const imported of output.imports) {
      if (!imported.external && imported.kind !== "dynamic-import") visit(imported.path);
    }
  };
  for (const [name, output] of Object.entries(metafile.outputs)) if (output.entryPoint && resolve(output.entryPoint) === resolve(entry)) visit(name);
}

export async function bundle(entry: string, outdir: string): Promise<Metafile> {
  entry = realpathSync(entry);
  if (resolve(outdir) === process.cwd()) throw new Error("Bundle outdir must not be the working directory: it is cleaned before building.");
  const fromOutput = relative(resolve(outdir), resolve(entry));
  if (fromOutput === "" || (!fromOutput.startsWith(`..${sep}`) && fromOutput !== "..")) {
    throw new Error("Bundle outdir must not contain the source entry: it is cleaned before building.");
  }
  rmSync(outdir, { recursive: true, force: true });
  const result = await build({
    entryPoints: [entry], outdir, bundle: true, splitting: true, format: "esm", platform: "neutral",
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"], minify: true, metafile: true, chunkNames: "chunks/[name]-[hash]",
  });
  guardStartup(result.metafile, entry);
  return result.metafile;
}
