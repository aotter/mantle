/** Warn when a surface the manifests select is generated but the app entry never imports it, so it is never served. */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { build } from "esbuild";

interface Surface { readonly module: string; readonly selected: (files: Readonly<Record<string, string>>) => boolean; readonly what: string; readonly topic: string }

const SURFACES: readonly Surface[] = [
  { module: "rest.ts", selected: files => files["rest.ts"]?.includes("pattern: new RegExp") ?? false, what: "REST routes", topic: "service-entry" },
  { module: "mcp.ts", selected: files => "mcp.ts" in files, what: "MCP tools", topic: "service-entry" },
  { module: "admin-bindings.ts", selected: files => "admin-bindings.ts" in files, what: "Admin bindings", topic: "native-admin" },
];

/** Follows relative static and dynamic imports from the entry; packages stay external, so nothing needs to be installed. */
export async function unmountedWarnings(entry: string, destination: string, files: Readonly<Record<string, string>>): Promise<string[]> {
  const selected = SURFACES.filter(surface => surface.selected(files));
  if (!selected.length || !existsSync(entry)) return [];
  let inputs: string[];
  try {
    const result = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, packages: "external", platform: "neutral", format: "esm", logLevel: "silent", absWorkingDir: process.cwd() });
    inputs = Object.keys(result.metafile.inputs).map(path => resolve(path));
  } catch {
    return [`could not follow imports from ${entry} to check which generated surfaces it serves; fix the entry's build errors (mantle bundle shows them).`];
  }
  return selected.filter(surface => !inputs.includes(resolve(destination, surface.module))).map(surface =>
    `${surface.what} are generated in ${relative(process.cwd(), resolve(destination, surface.module))}, but ${entry} never imports it, so no request reaches them. Mount it in the entry (mantle help ${surface.topic}), or pass --entry if the app starts elsewhere.`);
}
