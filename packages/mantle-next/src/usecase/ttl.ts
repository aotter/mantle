/** TTL maintenance sees expired rows, so it deliberately bypasses ordinary scope/read visibility. */
import type { RuntimePlan } from "@aotter/mantle/compiler";
import { dialect as sqlite } from "../kernel/dialect/sqlite.js";
import { dialect as postgres } from "../kernel/dialect/postgres.js";
import { entry, exportName, q } from "../domain/entry.js";
export function emitTtl(plan: RuntimePlan, isSqlite: boolean, declarations: string[], procedures: string[], entries: Record<string, string>, refuse: (path: string, message: string) => void): void {
  const d = isSqlite ? sqlite : postgres;
  const schemas = Object.values(plan.schemas).filter(s => s.ttl).sort((a,b) => a.name.localeCompare(b.name));
  if (schemas.length) declarations.push(`import { sweep as sweepTtl } from "@aotter/mantle-next/sweep";`, `import { cutoff as ttlCutoff } from "@aotter/mantle-next/dialect/${isSqlite ? "sqlite" : "postgres"}";`);
  for (const s of schemas) {
    const name = `${s.name}.sweepExpired`, fn = exportName("procedure", name), path = `procedures/${name}`;
    if (plan.procedures[name]) { refuse(path, "This name is reserved for generated TTL maintenance."); continue; }
    const pick = `SELECT _rid FROM ${d.ident(s.name)} WHERE ${d.ident(s.ttl!)} IS NOT NULL AND ${d.ident(s.ttl!)} <= ${d.param(1)} AND _rid > ${d.param(2)} ORDER BY _rid LIMIT ${d.param(3)}`;
    declarations.push(`export type ${fn}Input = import("@aotter/mantle-next/sweep").SweepInput;`, `export type ${fn}Result = import("@aotter/mantle-next/sweep").SweepResult;`, `async function ${fn}(db: Database, caller: Caller, input: ${fn}Input = {}): Promise<${fn}Result> { return sweepTtl(db, caller, input, ${q(path)}, ${s.ttlSeconds}, ${q([pick, `DELETE FROM ${d.ident(s.name)} WHERE _rid IN (${pick}) RETURNING _rid`])}, {cutoff: ttlCutoff}, DRIVER.procedure); }`, `export { ${fn} };`);
    procedures.push(`[${q(name)}]: ${fn}`);
    entries[`procedures/${encodeURIComponent(name)}.ts`] = entry("procedure", name, `${fn}Input as Input, ${fn}Result as Output`);
  }
}
