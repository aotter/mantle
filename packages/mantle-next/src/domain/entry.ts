/** Direct entry files: one View or Procedure per module, so a request bundle excludes the others. */
/**
 * Stable, injective build-only export names, so a stale entry file cannot bind a new ordinal: every byte outside [A-Za-z0-9]
 * (including `$` and `_`) is `$` and two hex digits.
 * @internal
 */
export const exportName = (kind: string, name: string) => kind + "_" + name.replace(/[^A-Za-z0-9]+/g, run => Array.from(new TextEncoder().encode(run), b => "$" + b.toString(16).padStart(2, "0")).join(""));
/** A direct entry: `import` then `export`, because Bun 1.3 drops a bare `export { x as default } from` binding under "sideEffects": false. `extra` is any further re-export line. */
/** @internal */
export const entry = (kind: string, name: string, types: string, extra = "") => `import { ${exportName(kind, name)} as operation } from "../generated.js";\nexport default operation;\nexport type { ${types} } from "../generated.js";\n${extra}`;

/** Source text of a JSON value. @internal */
export const q = JSON.stringify;
/** Whether a target's database is SQLite (bun:sqlite or D1). @internal */
export const isSqlite = (target: string): boolean => target === "bun-sqlite" || target === "cloudflare-d1";
/** A View's paged boundary and validated query reader, imported as `page<index>` and `<query><index>`. @internal */
export const viewImports = (name: string, index: number, query = "query"): string[] => [`import page${index} from "./paged/views/${encodeURIComponent(name)}.js";`, `import { query as ${query}${index} } from "./validation/views/${encodeURIComponent(name)}.js";`];
/** A generated host handle import, shared by the optional boundaries. @internal */
export const driverFor = (target: string): "bun-sqlite" | "d1" | "postgres" => target === "bun-sqlite" ? "bun-sqlite" : target === "cloudflare-d1" ? "d1" : "postgres";
export const databaseImport = (target: string): string => driverFor(target) === "postgres" ? 'import type { Postgres as Database } from "@aotter/mantle-next/contracts";' : `import type { Handle as Database } from "@aotter/mantle-next/driver/${driverFor(target)}";`;
