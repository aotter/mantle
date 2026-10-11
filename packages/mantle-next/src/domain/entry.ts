/** Direct entry files: one operation, Store or Procedure per module, so a request bundle excludes the others. */
// Stable, injective build-only export names; stale entry files cannot bind a new ordinal.
/** @internal */
export const exportName = (kind: string, name: string) => kind + "_" + Array.from(name, c => c.codePointAt(0)!.toString(16)).join("_");
/** A direct entry: `import` then `export`, because Bun 1.3 drops a bare `export { x as default } from` binding under "sideEffects": false. */
/** @internal */
export const entry = (kind: string, name: string, types: string) => `import { ${exportName(kind, name)} as operation } from "../generated.js";\nexport default operation;\nexport type { ${types} } from "../generated.js";\n`;

