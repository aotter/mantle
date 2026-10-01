import type { SqlNode } from "../model/SqlIr.js";

/** The Schemas a program reads (every table relation) and writes (a statement's target), by the plan's lower-case key. */
export function relationsOf(stmts: readonly SqlNode[]): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const walk = (v: unknown, write: boolean): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, false));
    if (!v || typeof v !== "object") return;
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
      const n = c as { relname?: string; mantle?: string } | null;
      // a write's target is a RangeVar without its type key, under `relation`
      if ((k === "RangeVar" || k === "relation") && n && typeof n.relname === "string" && n.mantle !== "cte") (write && k === "relation" ? writes : reads).add(n.relname.toLowerCase());
      walk(c, k === "InsertStmt" || k === "UpdateStmt" || k === "DeleteStmt" || k === "MergeStmt");
    }
  };
  walk(stmts, false);
  for (const w of writes) reads.delete(w);
  return { reads, writes };
}
