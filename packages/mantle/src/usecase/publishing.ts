/** Opt-in lifecycle: one atomic, version-guarded statement per transition, with Core's row rules. */
import { rowPolicy, type RuntimePlan } from "../build/compiler.js";
import { dialect as sqlite } from "../kernel/dialect/sqlite.js";
import { dialect as postgres } from "../kernel/dialect/postgres.js";
import { renderTerm, type Lock } from "../kernel/store.js";
import { publishedParent } from "./translations.js";
import { entry, exportName, q } from "../domain/entry.js";


import { publishingAnnotations, publishingInput, publishingTransitions } from "../domain/generated-tools.js";
export { publishingAnnotations, publishingInput, publishingTransitions };
/** The columns `publish` requires non-null, each with its declared field (a geo field is its two columns); a Store update of a published row cannot clear one (#1822). */
export const publishRequired = (s: RuntimePlan["schemas"][string]): [column: string, field: string][] => (s.schema.required ?? []).flatMap(field => Object.keys(s.fields).filter(c => (s.names?.[c] ?? c) === field).slice(0, 1)
  .flatMap(c => s.fields[c] === "geo" ? [[`${c}_lat`, field], [`${c}_lng`, field]] as [string, string][] : [[c, field] as [string, string]]));

export function emitPublishing(plan: RuntimePlan, isSqlite: boolean, declarations: string[], procedures: string[], entries: Record<string, string>, values: Set<string>, refuse: (path: string, message: string) => void, locks: Readonly<Record<string, readonly Lock[]>> = {}): void {
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
        const schema = plan.schemas[s.name]!;
        const recipes: object[] = [{ k: "now" }, { k: "input", name: "id" }, { k: "input", name: "expectedVersion" }];
        const conditions = [`id = ${d.param(2)}`, `version = ${d.param(3)}`, `status IN (${from.map(v => `'${v}'`).join(", ")})`];
        // Same visibility as Store and Admin writes, translation parent included (a child under an out-of-set parent is missing);
        // the status term is replaced by the transition's own `status IN (...)`.
        for (const term of rowPolicy(schema, trusted ? "trusted" : "caller", plan.schemas)) if (term[1] !== "admin")
          conditions.push(renderTerm(d, term, term[1] === "parent" ? d.ident(s.name) + "." : "", recipe => (recipes.push(recipe), d.param(recipes.length))));
        if (verb === "publish") for (const [column] of publishRequired(s)) conditions.push(`${d.ident(column)} IS NOT NULL`);
        if (verb === "publish" && s.translates) conditions.push(publishedParent(plan,schema,d,recipes,trusted));
        const clock = d.param(1);
        // a transition is an update: a caller's carries the Schema's `update` locks, and the probe that names one (#1822)
        const held = trusted ? [] : (locks[s.name.toLowerCase()] ?? []).filter(l => l.on.includes("update"));
        const lock = held.length ? (() => {
          // the same conditions but the version, renumbered without the clock: the row as this caller sees it
          const probe: object[] = [], number = new Map<number, string>(), renumber = (sql: string) => sql.replace(isSqlite ? /\?(\d+)/g : /\$(\d+)/g, (_, n: string) => {
            const i = Number(n);
            if (!number.has(i)) { probe.push(recipes[i - 1]!); number.set(i, d.param(probe.length)); }
            return number.get(i)!;
          });
          const where = renumber(conditions.filter(c => c !== `version = ${d.param(3)}`).join(" AND "));
          return { sql: `SELECT CASE ${held.map(l => `WHEN (${l.sql}) IS NOT FALSE THEN '${l.name}'`).join(" ")} END AS ${d.ident("lock")} FROM ${d.ident(s.name)} WHERE ${where}`, binds: probe, schema: s.name, verb: "update", locks: Object.fromEntries(held.map(l => [l.name, l.message])) };
        })() : undefined;
        conditions.push(...held.map(l => `NOT (${l.sql})`));
        return { sql: `UPDATE ${d.ident(s.name)} SET status = '${to}', published_at = ${verb === "publish" ? clock : "NULL"}, version = version + 1, updated_at = ${clock} WHERE ${conditions.join(" AND ")} RETURNING id, version, status, ${d.wireTimestamp(d.ident("published_at")).join("")} AS published_at`, binds: recipes, row: true, ...(lock ? { lock } : {}) };
      };
      values.add("now");
      const caller = q([statement(false)]), trusted = q([statement(true)]);
      declarations.push(`export type ${fn}Input = { readonly id: string; readonly expectedVersion: number };`, `const ${fn}Caller = ${caller} as const;`, ...(trusted === caller ? [] : [`const ${fn}Trusted = ${trusted} as const;`]),
        `async function ${fn}(db: Database, caller: Caller, raw: ${fn}Input): Promise<Output> { ${plan.access ? 'USER.modeOf(caller); ' : ''}return transition(db, caller, raw, ${q(path)}, ${plan.access ? "USER.scopedAll(" : ""}${trusted === caller ? "" : `${plan.access ? 'USER.modeOf(caller) === "trusted"' : 'caller.kind === "system"'} ? ${fn}Trusted : `}${fn}Caller${plan.access ? ", caller)" : ""}, ${q(failure)}, D, DRIVER.procedure${translations ? `, () => translationWrite(db, ${q(s.name)}, ${verb === "publish" && s.translates ? q(s.translates.parent) : "undefined"})` : ""}); }`, `export { ${fn} };`);
      procedures.push(`[${q(name)}]: ${fn}`);
      entries[`procedures/${encodeURIComponent(name)}.ts`] = entry("procedure", name, `${fn}Input as Input`, 'export type { Output } from "@aotter/mantle/contracts";\n');
    }
  }
}

/** Publishing lists get one index, prefixed by scope when present. */
export function publishingSql(schemas: RuntimePlan["schemas"], isSqlite: boolean): string[] {
  const d = isSqlite ? sqlite : postgres;
  return Object.values(schemas).filter(s => s.publishing).map(s => `CREATE INDEX ${d.ident(`_mantle_ix_${s.name}_published`)} ON ${d.ident(s.name)} (${[...(s.scope ? [s.scope] : []), ...(s.userScopes ?? []).map(u => u.column), "published_at", "id"].map(d.ident).join(", ")})`);
}
