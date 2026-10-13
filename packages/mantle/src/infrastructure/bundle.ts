import { realpathSync, rmSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { build, type Metafile } from "esbuild";

/** Only static imports run at startup; dynamic imports remain separate uploaded modules. */
export function startupGraph(metafile: Metafile, entry: string): string[] {
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const output = metafile.outputs[name]!;
    for (const imported of output.imports) {
      if (!imported.external && imported.kind !== "dynamic-import") visit(imported.path);
    }
  };
  for (const [name, output] of Object.entries(metafile.outputs)) if (output.entryPoint && resolve(output.entryPoint) === resolve(entry)) visit(name);
  return [...visited];
}

const refused: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|\/)node_modules\/(?:better-auth(?:\/|$)|@better-auth\/)/, "Load it through authLoader(() => import(...)) to keep Better Auth out of startup."],
  [/(?:^|\/)node_modules\/@modelcontextprotocol\//, "Load MCP through a request-time import(...)."],
  // the compiler: the package's own generator layers (installed, or workspace dist/source) and its parser, YAML and SQL dependencies
  [/(?:^|\/)node_modules\/(?:@aotter\/mantle\/dist\/(?:build|infrastructure)\/|yaml\/|pgsql-deparser\/|libpg-query\/)|(?:^|\/)mantle\/(?:dist|src)\/(?:build|infrastructure)\//, "Generator code must not run in a Worker; import runtime entry points such as @aotter/mantle/rest."],
];

export function guardStartup(metafile: Metafile, entry: string): void {
  for (const name of startupGraph(metafile, entry)) {
    const output = metafile.outputs[name]!;
    for (const input of Object.keys(output.inputs)) {
      // shortcut: vendored auth outside node_modules is not recognized; use package metadata if vendoring is supported.
      const hit = refused.find(([pattern]) => pattern.test(input.replaceAll("\\", "/")));
      if (hit) throw new Error(`Startup module ${name} contains ${input}. ${hit[1]}`);
    }
  }
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
