/** Opt-in lifecycle: one atomic, version-guarded statement per transition, with Core's row rules. */
import { rowPolicy, type JsonSchema, type RuntimePlan } from "../build/compiler.js";
import { dialect as sqlite } from "../kernel/dialect/sqlite.js";
import { dialect as postgres } from "../kernel/dialect/postgres.js";
import { renderTerm } from "../kernel/store.js";
import { publishedParent } from "./translations.js";
import { STAFF_ROLES } from "../domain/visibility.js";
import { entry, exportName, q } from "../domain/entry.js";


export const publishingTransitions = [["publish", ["draft"], "published"], ["unpublish", ["published", "archived"], "draft"], ["archive", ["draft", "published"], "archived"]] as const;
export const publishingInput: JsonSchema = {type:"object",properties:{id:{type:"string",minLength:1},expectedVersion:{type:"integer",minimum:1}},required:["id","expectedVersion"],additionalProperties:false};
export function emitPublishing(plan: RuntimePlan, isSqlite: boolean, declarations: string[], procedures: string[], entries: Record<string, string>, values: Set<string>, refuse: (path: string, message: string) => void): void {
  const d = isSqlite ? sqlite : postgres;
  const translations = Object.values(plan.schemas).some(s=>s.translates);
  if(translations)declarations.push('import {translationWrite} from "@aotter/mantle/driver/transaction-context";');
  if(Object.values(plan.schemas).some(s=>s.publishing))declarations.push('import { transition } from "@aotter/mantle/publishing";');
  for (const s of Object.values(plan.schemas).filter(s => s.publishing).sort((a, b) => a.name.localeCompare(b.name))) {
    if (Object.hasOwn(s.fields, "published_at")) { refuse(`schemas/${s.name}`, "published_at is a publishing system column; remove the declared field."); continue; }
    if (s.ttl) values.add("cutoff");
    for (const [verb, from, to] of publishingTransitions) {
      const name = `${s.name}.${verb}`, fn = exportName("procedure", name), path = `procedures/${name}`;
      const failure = `${verb}: row is missing or excluded, expectedVersion differs, status is not ${from.join(" or ")}${verb === "publish" ? `, or required data is missing${s.translates ? ", or no visible published parent shares the join key" : ""}` : ""}.`;
      if (plan.procedures[name]) { refuse(path, "This name is reserved for the generated publishing transition."); continue; }
      const statement = (trusted: boolean) => {
        const recipes: object[] = [{ k: "now" }, { k: "input", name: "id" }, { k: "input", name: "expectedVersion" }];
        const conditions = [`id = ${d.param(2)}`, `version = ${d.param(3)}`, `status IN (${from.map(v => `'${v}'`).join(", ")})`];
        for (const term of rowPolicy(s, trusted ? "trusted" : "caller", STAFF_ROLES, plan.schemas)) {
          recipes.push(term[2]);
          conditions.push(renderTerm(d, term, "", d.param(recipes.length)));
        }
        if (verb === "publish") for (const field of s.schema.required ?? []) {
          const column = Object.keys(s.fields).find(c => (s.names?.[c] ?? c) === field);
          if (column) conditions.push(`${d.ident(column)} IS NOT NULL`);
        }
        if (verb === "publish" && s.translates) conditions.push(publishedParent(plan,s,d,recipes,trusted));
        const clock = d.param(1);
        return { sql: `UPDATE ${d.ident(s.name)} SET status = '${to}', published_at = ${verb === "publish" ? clock : "NULL"}, version = version + 1, updated_at = ${clock} WHERE ${conditions.join(" AND ")} RETURNING id, version, status, ${d.wireTimestamp(d.ident("published_at")).join("")} AS published_at`, binds: recipes, row: true };
      };
      values.add("now");
      const caller = q([statement(false)]), trusted = q([statement(true)]);
      declarations.push(`export type ${fn}Input = { readonly id: string; readonly expectedVersion: number };`, `const ${fn}Caller = ${caller} as const;`, ...(trusted === caller ? [] : [`const ${fn}Trusted = ${trusted} as const;`]),
        `async function ${fn}(db: Database, caller: Caller, raw: ${fn}Input): Promise<Output> { return transition(db, caller, raw, ${q(path)}, ${q(STAFF_ROLES)}, ${trusted === caller ? "" : `caller.kind === "system" ? ${fn}Trusted : `}${fn}Caller, ${q(failure)}, D, DRIVER.procedure${translations ? `, () => translationWrite(db, ${q(s.name)}, ${verb === "publish" && s.translates ? q(s.translates.parent) : "undefined"})` : ""}); }`, `export { ${fn} };`);
      procedures.push(`[${q(name)}]: ${fn}`);
      entries[`procedures/${encodeURIComponent(name)}.ts`] = entry("procedure", name, `${fn}Input as Input`, 'export type { Output } from "@aotter/mantle/contracts";\n');
    }
  }
}

/** Publishing lists get one index, prefixed by scope when present. */
export function publishingSql(schemas: RuntimePlan["schemas"], isSqlite: boolean): string[] {
  const d = isSqlite ? sqlite : postgres;
  return Object.values(schemas).filter(s => s.publishing).map(s => `CREATE INDEX ${d.ident(`_mantle_ix_${s.name}_published`)} ON ${d.ident(s.name)} (${[...(s.scope ? [s.scope] : []), "published_at", "id"].map(d.ident).join(", ")})`);
}
