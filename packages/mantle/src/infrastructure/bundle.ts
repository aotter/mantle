import { readFileSync, realpathSync, rmSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { build, type Metafile } from "esbuild";
import { authTableSql, extraRoles, staleInputs } from "./inputs.js";

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
    plugins: [{ name: "optional-peers", setup(builder) {
      builder.onResolve({ filter: /^(?:better-auth|@better-auth\/(?:core|oauth-provider)|@modelcontextprotocol\/server)(?:\/|$)/ }, async args => {
        if (args.pluginData?.optionalPeer) return;
        const resolved = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind, pluginData: { optionalPeer: true } });
        // Unselected request paths may reference absent peers; installed peers still bundle normally.
        return resolved.errors.length ? { path: args.path, external: true } : resolved;
      });
    } }],
  });
  if (Object.keys(result.metafile.inputs).some(input => /(?:^|\/)mantle\/(?:src|dist)\/testing\//.test(resolve(input).replaceAll("\\", "/"))))
    throw new Error("@aotter/mantle/testing is only for tests and cannot be bundled for production.");
  // A build is what `wrangler dev` and deploys run: generated code must match the manifests it came from.
  for (const input of Object.keys(result.metafile.inputs).filter(input => /(?:^|\/)generated\.ts$/.test(input))) {
    const stale = staleInputs(resolve(input));
    if (stale.length) throw new Error(`Generated output in ${relative(process.cwd(), resolve(input, ".."))} is stale (${stale.join("; ")}). Run your generate script (mantle generate ...) and rebuild.`);
  }
  const appSources = Object.keys(result.metafile.inputs).filter(input => !/node_modules|(?:^|\/)generated\//.test(input) && /\.[cm]?[jt]s$/.test(input)).map(input => [input, readFileSync(input, "utf8")] as const);
  for (const [input, source] of appSources) {
    const tables = authTableSql(source);
    if (tables.length) console.warn(`note: ${input} queries Better Auth's ${tables.join(", ")} table with SQL. Read users through userOf(caller) or readIdentity(auth) (@aotter/mantle/auth, @aotter/mantle/auth/identity), which follow each instance's table mapping and ban state.`);
  }
  const roles = appSources.flatMap(([, source]) => extraRoles(source));
  if (roles.length) console.warn(`note: Better Auth roles beyond admin and user: ${[...new Set(roles)].join(", ")}. Mantle grants by the admin layer and app code; keep extra roles only if the app needs them.`);
  guardStartup(result.metafile, entry);
  return result.metafile;
}
