/** Opt-in lifecycle: one atomic, version-guarded statement per transition, with Core's row rules. */
import { rowPolicy, type RuntimePlan } from "@aotter/mantle/spec";
import { dialect as sqlite } from "../kernel/dialect/sqlite.js";
import { dialect as postgres } from "../kernel/dialect/postgres.js";
import { renderTerm } from "../kernel/store.js";
import { entry, exportName } from "../domain/entry.js";

import { STAFF_ROLES } from "../domain/visibility.js";

const q = JSON.stringify;
export function emitPublishing(plan: RuntimePlan, isSqlite: boolean, declarations: string[], procedures: string[], entries: Record<string, string>, values: Set<string>, refuse: (path: string, message: string) => void): void {
  const d = isSqlite ? sqlite : postgres;
  for (const s of Object.values(plan.schemas).filter(s => s.publishing).sort((a, b) => a.name.localeCompare(b.name))) {
    if (Object.hasOwn(s.fields, "published_at")) { refuse(`schemas/${s.name}`, "published_at is a publishing system column; remove the declared field."); continue; }
    if (s.ttl) values.add("cutoff");
    for (const [verb, from, to] of [["publish", ["draft"], "published"], ["unpublish", ["published"], "draft"], ["archive", ["draft", "published"], "archived"]] as const) {
      const name = `${s.name}.${verb}`, fn = exportName("procedure", name), path = `procedures/${name}`;
      const failure = `${verb}: row is missing or excluded, expectedVersion differs, status is not ${from.join(" or ")}${verb === "publish" ? ", or required data is missing" : ""}.`;
      if (plan.procedures[name]) { refuse(path, "This name is reserved for the generated publishing transition."); continue; }
      const statement = (trusted: boolean) => {
        const recipes: object[] = [{ k: "now" }, { k: "input", name: "id" }, { k: "input", name: "expectedVersion" }];
        const conditions = [`id = ${d.param(2)}`, `version = ${d.param(3)}`, `status IN (${from.map(v => `'${v}'`).join(", ")})`];
        for (const term of rowPolicy(s, trusted ? "trusted" : "caller")) {
          recipes.push(term[2]);
          conditions.push(renderTerm(d, term, "", d.param(recipes.length)));
        }
        if (verb === "publish") for (const field of s.schema.required ?? []) {
          const column = Object.keys(s.fields).find(c => (s.names?.[c] ?? c) === field);
          if (column) conditions.push(`${d.ident(column)} IS NOT NULL`);
        }
        const clock = d.param(1);
        return { sql: `UPDATE ${d.ident(s.name)} SET status = '${to}', published_at = ${verb === "publish" ? clock : "NULL"}, version = version + 1, updated_at = ${clock} WHERE ${conditions.join(" AND ")} RETURNING id, version, status, ${d.wireTimestamp(d.ident("published_at")).join("")} AS published_at`, binds: recipes, row: true };
      };
      values.add("now");
      declarations.push(`export type ${fn}Input = { readonly id: string; readonly expectedVersion: number };`, `const ${fn}Caller = ${q([statement(false)])} as const;`, `const ${fn}Trusted = ${q([statement(true)])} as const;`,
        `async function ${fn}(db: Database, caller: Caller, raw: ${fn}Input): Promise<Output> {`,
        `  deny(caller, caller.kind === "system" || caller.kind === "user" && ${q(STAFF_ROLES)}.includes(caller.role ?? ""), ${q(path)});`,
        `  return { results: await DRIVER.procedure(db, bound(D, caller.kind === "system" ? ${fn}Trusted : ${fn}Caller, caller, raw), ${q(path)}).catch(error => { if (error?.code === "CONFLICT" && error.message === "Expected one affected row.") error.message = ${q(failure)}; throw error; }) };`, "}", `export { ${fn} };`);
      procedures.push(`[${q(name)}]: ${fn}`);
      entries[`procedures/${encodeURIComponent(name)}.ts`] = entry("procedure", name, `${fn}Input as Input`, 'export type { Output } from "@aotter/mantle-next/contracts";\n');
    }
  }
}

/** Publishing lists get one index, prefixed by scope when present. */
export function publishingSql(schemas: RuntimePlan["schemas"], isSqlite: boolean): string[] {
  const d = isSqlite ? sqlite : postgres;
  return Object.values(schemas).filter(s => s.publishing).map(s => `CREATE INDEX ${d.ident(`_mantle_ix_${s.name}_published`)} ON ${d.ident(s.name)} (${[...(s.scope ? [s.scope] : []), "published_at", "id"].map(d.ident).join(", ")})`);
}
