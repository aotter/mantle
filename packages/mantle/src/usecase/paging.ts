import { userReferences } from "../domain/userReferences.js";
/** Selected View boundary: Core prints keyset SQL once; bare operations retain native rows. */
import { parseNumeric, type RuntimePlan, type PlanLowered, type SqlNode } from "../build/compiler.js";
import { outputConversions } from "../domain/columns.js";
import type { Target } from "../domain/model.js";
import {authLines} from "../domain/input.js";
import { driverFor, databaseImport, isSqlite, q } from "../domain/entry.js";
import type { PagingProof } from "../domain/paging.js";
import { recipesOf } from "../domain/recipes.js";

export function emitPaging(plan: RuntimePlan, lowered: PlanLowered, target: string, refuse: (path: string, message: string) => void, proofs?: Readonly<Record<string, PagingProof | undefined>>, boundary = false): Record<string, string> {
  const files: Record<string, string> = {}, base = "@aotter/mantle/";
  const sqlite = isSqlite(target);
  const user = userReferences(plan, sqlite);
  const driver = driverFor(target);
  for (const [name, view] of Object.entries(plan.views)) {
    if (boundary && (view.surface === "internal" || !outputConversions(plan,name,target as Target).some(([,type])=>type==="int"))) continue;
    const path = `views/${name}`, sel = view.stmts[0]?.SelectStmt;
    const proof = proofs?.[name];
    if (boundary && (!proof || !proof.types.length && !proof.single)) continue;
    // Internal bare queries remain available even when they cannot be safely paged.
    if (!proof || !proof.types.length && !proof.single) {
      if (view.surface !== "internal") refuse(path, proof?.reason ?? "Paged Views need a complete typed NOT NULL key tuple, indexed Schema order and a non-fanning relation, or a proved singleton.");
      continue;
    }
    const mode = view.surface === "public" ? "public" : "caller";
    const c = lowered.views[name]?.[mode], trusted = mode === "caller" ? lowered.views[name]?.trusted : undefined;
    if (!c) continue;
    const hidden = new Set(Array.from({ length: c.nkeys }, (_, i) => `_k${i}`));
    if (Object.values(c.paged).some(p => p.names.some(name => hidden.has(sqlite ? name.toLowerCase() : name)))) {
      if (view.surface !== "internal") refuse(path, "Paged output names must not collide with the compiler's hidden cursor keys.");
      continue;
    }
    const cap = sel.limitCount?.A_Const?.ival?.ival ?? 500;
    if (sel.limitCount && (!sel.limitCount.A_Const?.ival || !Number.isInteger(cap) || cap < 1)) { refuse(path, "A paged View LIMIT must be a positive integer literal."); continue; }
    const values = new Set<string>();
    const kinds = proof.types.map(type => {
      if (type === "date" || type === "timestamptz") values.add(type === "date" ? "date" : "timestamp");
      return type === "bool" ? "bool" : type === "int4" ? "int4" : ["integer", "int8"].includes(type) ? "int" : parseNumeric(type) ? "numeric" : ["real", "float8"].includes(type) ? "float" : type === "date" ? "date" : type === "timestamptz" ? "timestamp" : "text";
    });
    const variants = [c, ...(trusted ? [trusted] : [])].map(v => {
      const pages = Object.values(v.paged);
      const first = pages.find(p => !p.sources.some(s => "cursor" in s)), next = pages.find(p => p.sources.some(s => "cursor" in s));
      if (!first || v.nkeys !== proof.types.length || v.nkeys > 0 && !next) { refuse(path, "Core could not lower this View's keyset pages."); return ""; }
      const recipes = recipesOf(v, Object.keys(view.input?.properties ?? {}), message => refuse(path, message), values);
      const page = (p: typeof first) => `{ sql: ${q(p.sql)}, extra: ${q(p.sources.map(s => "cursor" in s ? s.cursor : -1))} }`;
      return `{ binds: ${q(recipes)}, first: ${page(first)}, next: ${page(next ?? first)} }`;
    });
    const auth = authLines(view.requires,path);
    const spec = [`path: ${q(path)}`, `cap: ${cap}`, `sqlite: ${sqlite}`, `cursor: ${q(kinds)}`, `keys: ${c.nkeys}`, `values: {${user.used ? [...values].sort().concat(user.values).join(", ") : values.size ? ` ${[...values].sort().join(", ")} ` : ""}}`, "read", `caller: ${variants[0]}`, ...(trusted ? [`trusted: ${variants[1]}`] : []), ...(auth.length ? [`auth: (caller: Caller) => {\n${auth.join("\n")}\n  }`] : [])];
    files[`paged/${boundary ? "wire/" : ""}views/${encodeURIComponent(name)}.ts`] = `${user.code ? user.code+"\n" : ""}import { page, type Paged } from "${base}paging";
import { ${auth.length ? "deny, isAdmin, isUser, " : ""}type Caller${sqlite ? "" : ", type Unsafe as Database"} } from "${base}contracts";
${sqlite ? databaseImport(target) + "\n" : ""}import { read } from "${base}driver/${driver}";
${values.size ? `import { ${[...values].sort().join(", ")} } from "${base}dialect/${sqlite ? "sqlite" : "postgres"}";\n` : ""}import type { Input, Row } from "${boundary ? "../../../" : "../../"}views/${encodeURIComponent(name)}.js";
const spec: Paged<Database> = {
  ${spec.join(",\n  ")},
};
export default (db: Database, caller: Caller, input: Input, options?: { limit?: number; cursor?: string }) => page<Database, Row>(${user.used ? "{ ...spec, caller: USER.scopedAll(spec.caller, caller) }" : "spec"}, db, caller, input, options);
`;
  }
  return files;
}
