/**
 * `verifyPlan`: everything boot checks about an uploaded plan, plus every program through the storage's dialect, without a
 * database or the handlers (ADR-0034 decision 7: Cloud validates the IR and never parses SQL). Worker-safe: no SQL parser.
 */
import { DiagnosticError, makeDiagnostic, type Diagnostic } from "../../spec/kernel/index.js";
import { MAX_TTL_SECONDS, ManifestParseError, canonical, NATIVE_OUTPUT_TYPES, SqlRefusal, checkViewAdminUi, checkShapeProblem, viewCacheProblem, fieldTypes, storageColumnClash, storageColumns, isFieldType, isTtlSeconds, mcpTools, sideTableClashes, type JsonSchema, type ProcedureManifest, type RuntimePlan, type SchemaManifest, type SqlNode, type TriggerManifest, type ViewManifest } from "../../spec/domain/index.js";
import { validateJsonSchema } from "../../spec/domain/service/SchemaSpecChecks.js";
import { checkGuards, checkProcedureTarget, checkTriggerRefs } from "../../spec/domain/service/TriggerGraphChecks.js";
import { MAX_NODES, schemaColumns } from "../sql/allowlist.js";
import { compileProgram, type Mode } from "../sql/compile.js";
import { loweringStatus, lowerPlan } from "../sql/lowered.js";
import { outName } from "../sql/run.js";
import type { MantleStorageAdapter } from "../service.js";
import { createMantleRuntime } from "./createRuntime.js";

/**
 * The most a plan `verifyPlan` checks may hold, checked before anything else: every check below is linear in these. Each is many
 * times what a real app declares (Mantle Cloud's Control plan: 8 Schemas of at most 8 fields, 10 Views, 59 Procedures, 79 Triggers).
 */
export const PLAN_LIMITS = {
  schemas: 256,
  fieldsPerSchema: 256,
  checksPerSchema: 32,
  views: 1024,
  procedures: 1024,
  triggers: 2048,
  /** JSON objects and arrays in one program's IR (a check, a View, an inline Procedure): the allowlist walks at most `MAX_NODES` nodes, each a few of these */
  programIrValues: 8 * MAX_NODES,
  /** JSON objects and arrays in `lowered` (ADR-0044): its bind recipes and paging metadata, counted before it is compared or seeded */
  loweredValues: 64 * MAX_NODES,
  /** characters of printed SQL in `lowered` */
  loweredSqlChars: 8_000_000,
} as const;

const BOOTED = Symbol("booted");

const refused = (path: string, message: string): Diagnostic => makeDiagnostic({ code: "INPUT_VALIDATION_FAILED", phase: "boot", severity: "error", path, message });

/**
 * The plan's diagnostics: a plan past `PLAN_LIMITS` (checked first, and alone), what boot refuses before storage (version,
 * fingerprint, dialect, Triggers, guard and hook targets), what the CLI's own validators refuse of the manifests the plan stands
 * for (`planShape`: its JSON Schemas, fields, TTL, graph checks), and every
 * Schema check, View and inline Procedure through the storage's dialect (with its `restrict`) and the policy rewrite. Empty
 * means every program reads and writes only through the policy rewrite, in the shapes the dialect allows. It does not type-check
 * the SQL: a statement the database refuses (a function's argument count or type, an operand type) fails that call, or boot for
 * a check, with the database's error, never past the policy. Only `storage.dialect` is read, so storage's own refusals (a
 * reserved table name, a column type it cannot store) still surface where the plan first boots against its database.
 * Handlers are not checked (the host binds them); enabled schedule Triggers are allowed (the host decides whether it wires them).
 */
export async function verifyPlan(plan: RuntimePlan, storage: Pick<MantleStorageAdapter, "dialect">): Promise<readonly Diagnostic[]> {
  // the plan is untrusted input: a shape Core does not expect is a refusal, never an exception
  try {
    return await verify(plan, storage);
  } catch (e) {
    if (e instanceof DiagnosticError) return e.diagnostics;
    return [makeDiagnostic({ code: "INVALID_MANIFEST_ENVELOPE", phase: "boot", severity: "error", path: "plan", message: `the plan is malformed: ${e instanceof Error ? e.message : String(e)}` })];
  }
}

async function verify(plan: RuntimePlan, storage: Pick<MantleStorageAdapter, "dialect">): Promise<readonly Diagnostic[]> {
  const tooLarge = bounds(plan);
  if (tooLarge.length) return tooLarge;
  const refs = Object.values(plan.procedures).flatMap((p) => ("ref" in p.handler ? [p.handler.ref] : []));
  try {
    // boot's own checks, stopped where storage would be prepared
    await createMantleRuntime({ plan, handlers: Object.fromEntries(refs.map((r) => [r, () => undefined])), schedules: true, storage: { dialect: storage.dialect, prepare: () => Promise.reject(BOOTED) } });
  } catch (e) {
    if (e !== BOOTED) throw e;
  }
  const out: Diagnostic[] = [...planShape(plan)];
  // what the allowlist reads off every Schema, once for the plan rather than once per program
  const columns = schemaColumns(plan.schemas);
  const check = (path: string, stmts: readonly SqlNode[], inputs: Readonly<Record<string, string>>, kind: "view" | "procedure", mode: Mode) => {
    try {
      return compileProgram(stmts, { dialect: storage.dialect, schemas: plan.schemas, columns, inputs, kind, mode });
    } catch (e) {
      // the dialect's refusals arrive as a DiagnosticError, the policy rewrite's as a SqlRefusal; the runtime refuses both
      if (e instanceof DiagnosticError) out.push(...e.diagnostics.map((d) => ({ ...d, path })));
      else if (e instanceof SqlRefusal) out.push(refused(path, `${e.code}: ${e.message}`));
      else throw e;
      return undefined;
    }
  };
  // a check is printed into the table's DDL and runs on every write: checked as the CLI compiles it, the WHERE of a read of its own Schema
  for (const [name, schema] of Object.entries(plan.schemas))
    for (const [i, where] of (schema.checks ?? []).entries()) {
      const path = `plan#/schemas/${name}/checks/${i}`;
      const problem = checkShapeProblem(where, storageColumns(schema));
      if (problem) out.push(refused(path, `SQL_SHAPE: ${problem}`));
      else check(path, [{ SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }], fromClause: [{ RangeVar: { relname: name.toLowerCase(), inh: true, relpersistence: "p", mantle: "table" } }], whereClause: where, limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }], {}, "view", "caller");
    }
  for (const [name, v] of Object.entries(plan.views)) {
    const compiled = check(`plan#/views/${name}`, v.stmts, v.inputs, "view", v.surface === "public" ? "public" : "caller");
    if (compiled && v.sharedMaxAge !== undefined && !out.some((d) => d.path === `plan#/views/${name}/sharedMaxAge`)) {
      const problem = viewCacheProblem(v.stmts, plan.schemas);
      if (problem) out.push(refused(`plan#/views/${name}/sharedMaxAge`, `VIEW_CACHE_INVALID: ${problem}`));
    }
    // searchFields and filterFields are matched against the outputs of the statement the policy wrote, by runView's rule
    const outputs = (compiled?.[0]?.ast.SelectStmt?.targetList ?? []).map(outName);
    const list = listOf(v.uiSchema);
    if (compiled) for (const key of ["searchFields", "filterFields"] as const)
      for (const f of Array.isArray(list?.[key]) ? (list[key] as unknown[]) : []) if (typeof f === "string" && !outputs.includes(f) && !outputs.includes(f.toLowerCase())) out.push(refused(`plan#/views/${name}/uiSchema/list/${key}`, `VIEW_UI_INVALID: ${JSON.stringify(f)} is not an output of the View`));
  }
  for (const [name, p] of Object.entries(plan.procedures)) if ("sql" in p.handler) check(`plan#/procedures/${name}`, p.handler.sql.stmts, p.inputs, "procedure", "caller");
  // the statements a runtime will run without checking them (ADR-0044): what this Mantle and dialect print for the plan's programs, or nothing.
  // Only against a plan that is otherwise sound (a refused program is left out of the lowering, so the comparison would only repeat that).
  // A lowering this Mantle cannot re-derive (another Mantle version, another dialect, a dialect that cannot print) is refused, never skipped: a
  // runtime of that version would seed it unchecked. Only under `restrict`, where no runtime uses lowered statements, is the comparison skipped
  if (!out.length && plan.lowered !== undefined) {
    const status = loweringStatus(plan, storage.dialect);
    if (status === "used") {
      const { fingerprint: _fingerprint, lowered, ...body } = plan;
      if (canonical(lowerPlan(body, storage.dialect).lowered) !== canonical(lowered))
        out.push(refused("plan#/lowered", "LOWERING_MISMATCH: the plan's lowered statements are not what this Mantle and dialect print for its programs; regenerate the plan (`mantle generate`)"));
    } else if (status !== "restricted")
      out.push(refused("plan#/lowered", `LOWERING_MISMATCH: lowered statements this Mantle cannot re-derive (${status}); regenerate the plan with this Mantle or remove lowered`));
  }
  return out;
}

/** JSON objects and arrays in `value`, counted up to `cap` (past it the count stops): iterative, so any depth is safe. */
function jsonValues(value: unknown, cap: number): number {
  let n = 0;
  const stack: unknown[] = [value];
  while (stack.length && n <= cap) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    n++;
    for (const c of Array.isArray(v) ? v : Object.values(v)) if (c !== null && typeof c === "object") stack.push(c);
  }
  return n;
}

/** The plan within `PLAN_LIMITS`: one diagnostic per limit passed, before any check reads more of the plan. */
function bounds(plan: RuntimePlan): Diagnostic[] {
  const out: Diagnostic[] = [];
  const over = (path: string, what: string, limit: number) => out.push(makeDiagnostic({ code: "RESOURCE_EXHAUSTED", phase: "boot", severity: "error", path, message: `the plan has more than ${limit} ${what}` }));
  const count = (x: unknown) => (x && typeof x === "object" ? Object.keys(x).length : 0);
  const L = PLAN_LIMITS;
  if (count(plan.schemas) > L.schemas) over("plan#/schemas", "Schemas", L.schemas);
  if (count(plan.views) > L.views) over("plan#/views", "Views", L.views);
  if (count(plan.procedures) > L.procedures) over("plan#/procedures", "Procedures", L.procedures);
  if (count(plan.triggers) > L.triggers) over("plan#/triggers", "Triggers", L.triggers);
  if (out.length) return out;
  const program = (path: string, ir: unknown) => { if (jsonValues(ir, L.programIrValues) > L.programIrValues) over(path, "IR values in one program", L.programIrValues); };
  for (const [name, s] of Object.entries(plan.schemas)) {
    if (count(s?.fields) > L.fieldsPerSchema) over(`plan#/schemas/${name}/fields`, "fields in one Schema", L.fieldsPerSchema);
    const checks = Array.isArray(s?.checks) ? s.checks : [];
    if (checks.length > L.checksPerSchema) over(`plan#/schemas/${name}/checks`, "checks in one Schema", L.checksPerSchema);
    else checks.forEach((c, i) => program(`plan#/schemas/${name}/checks/${i}`, c));
  }
  for (const [name, v] of Object.entries(plan.views)) program(`plan#/views/${name}`, v?.stmts);
  for (const [name, p] of Object.entries(plan.procedures)) if (p?.handler && "sql" in p.handler) program(`plan#/procedures/${name}`, p.handler.sql?.stmts);
  if (plan.lowered !== undefined) {
    // checked before it is compared or seeded, as the programs are: it names only the plan's own programs, and holds no more than they could print
    const l = plan.lowered as unknown as Record<string, unknown> | null;
    const programs = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);
    const views = programs(l?.["views"]), procedures = programs(l?.["procedures"]);
    if (!l || typeof l !== "object" || !views || !procedures) out.push(refused("plan#/lowered", "LOWERING_MISMATCH: lowered is an object with views and procedures"));
    else {
      for (const name of Object.keys(views)) if (!Object.hasOwn(plan.views, name)) out.push(refused(`plan#/lowered/views/${name}`, "LOWERING_MISMATCH: lowered names a View the plan does not have"));
      for (const name of Object.keys(procedures)) if (!Object.hasOwn(plan.procedures, name)) out.push(refused(`plan#/lowered/procedures/${name}`, "LOWERING_MISMATCH: lowered names a Procedure the plan does not have"));
      if (jsonValues(l, L.loweredValues) > L.loweredValues) over("plan#/lowered", "JSON values in the lowered statements", L.loweredValues);
      else if (sqlChars(l) > L.loweredSqlChars) over("plan#/lowered", "characters of lowered SQL", L.loweredSqlChars);
    }
  }
  return out;
}

/** The characters of every `sql` string in `value`, counted up to `cap` (past it the count stops): iterative, so any depth is safe. */
function sqlChars(value: unknown): number {
  let n = 0;
  const stack: unknown[] = [value];
  while (stack.length && n <= PLAN_LIMITS.loweredSqlChars) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    for (const [k, c] of Object.entries(v)) {
      if (k === "sql" && typeof c === "string") n += c.length;
      else if (c !== null && typeof c === "object") stack.push(c);
    }
  }
  return n;
}

/** The CLI's own JSON Schema check (depth, size, `$ref`, `pattern`, `enum`) on one of the plan's: its refusal, or undefined. */
function jsonSchemaProblem(schema: unknown, path: string, kind: "Schema" | "View" | "Procedure", name: string): Diagnostic | undefined {
  try {
    validateJsonSchema(schema, undefined as unknown as number, kind, name, ""); // no document index: the path names the schema
    return undefined;
  } catch (e) {
    if (!(e instanceof ManifestParseError)) throw e;
    return refused(`${path}${e.pointer ?? ""}`, `${e.code}: ${e.message}`);
  }
}

/** Whether two string maps hold the same entries. */
const sameMap = (a: unknown, b: Readonly<Record<string, string>>) =>
  !!a && typeof a === "object" && Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => Object.hasOwn(a, k) && (a as Record<string, unknown>)[k] === v);

/**
 * The CLI's graph checks (the linker's), run on the plan's equivalents of the manifests they read: http Trigger paths under
 * `/api/` and unique per method, lifecycle Triggers that name a Schema as declared, schedule targets a system caller can call,
 * guards, and Procedure targets. Only errors: a warning is the author's to see.
 */
function graphChecks(plan: RuntimePlan): Diagnostic[] {
  const procedures = new Map(Object.entries(plan.procedures).map(([name, p]) => [name, { kind: "Procedure", metadata: { name }, spec: { ...p, handler: "ref" in p.handler ? { ref: p.handler.ref } : { sql: p.handler.source } } } as unknown as ProcedureManifest]));
  const views = Object.entries(plan.views).map(([name, v]) => ({ kind: "View", metadata: { name }, spec: v }) as unknown as ViewManifest);
  const triggers = Object.entries(plan.triggers).map(([name, t]) => ({ kind: "Trigger", metadata: { name }, spec: { source: t.source, target: { procedure: t.procedure } } }) as unknown as TriggerManifest);
  const schemas = new Map(Object.values(plan.schemas).map((s) => [s.name, { kind: "Schema", metadata: { name: s.name }, spec: { schema: s.schema } } as unknown as SchemaManifest]));
  const PLURAL: Record<string, string> = { Trigger: "triggers", Procedure: "procedures", View: "views", Schema: "schemas" };
  return [
    ...[...procedures.values()].flatMap((p) => checkProcedureTarget(p, schemas)),
    ...checkGuards([...procedures.values(), ...views], procedures),
    ...checkTriggerRefs(triggers, procedures, undefined, schemas),
  ].filter((d) => d.severity === "error").map((d) => {
    // `manifest:Kind/name#/spec/...` names the plan's entry
    const m = /^manifest:(\w+)\/(.*)#(?:\/spec)?(.*)$/s.exec(d.path);
    return m && PLURAL[m[1]!] ? { ...d, path: `plan#/${PLURAL[m[1]!]}/${m[2]}${m[3]}` } : d;
  });
}

const NATIVE = new Set(["id", "version", "status", "author_id", "created_at", "updated_at"]);
const listOf = (uiSchema: unknown) => (uiSchema as { list?: Record<string, unknown> } | undefined)?.list;

/**
 * What the CLI guarantees about the plan's other fields, checked in one pass: a Schema's names as the CLI writes them (its key,
 * fields, scope, ttl, search, unique and index columns lower case, each a declared field or a native column; SQL folds names, the
 * checks compare folded names and storage quotes them, so a plan whose `Items` and `items`, or scope `Owner` and field `owner`, are
 * two things to one layer and one to another is refused), its field types and TTL as storage takes them, search and geo tables that
 * name one object each; a View's `columns` and Admin list as Store and Admin read them; and MCP tools that do not collide.
 */
function planShape(plan: RuntimePlan): Diagnostic[] {
  const out: Diagnostic[] = [];
  const isName = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x === x.toLowerCase();
  // every JSON Schema as the CLI checks a manifest's: Store and invocation validate values against them, and a `$ref` cycle or an
  // exponential `pattern` there would throw or stall on every call
  let schemasOk = true;
  const jsonSchema = (schema: unknown, path: string, kind: "Schema" | "View" | "Procedure", name: string) => {
    const problem = jsonSchemaProblem(schema, path, kind, name);
    if (problem) (out.push(problem), (schemasOk = false));
    return !problem;
  };
  // a program's `inputs` are its input's properties typed as the CLI types them: the allowlist and binds read one, Store the other
  const inputs = (path: string, input: JsonSchema | undefined, declared: unknown) => {
    if (!sameMap(declared, fieldTypes(input))) out.push(refused(`${path}/inputs`, "SQL_SHAPE: inputs are the input's properties, typed as the CLI types them"));
  };
  for (const [name, v] of Object.entries(plan.views)) {
    const path = `plan#/views/${name}`;
    if (v.input === undefined || jsonSchema(v.input, `${path}/input`, "View", name)) inputs(path, v.input, v.inputs);
  }
  for (const [name, p] of Object.entries(plan.procedures)) {
    const path = `plan#/procedures/${name}`;
    if (jsonSchema(p.input, `${path}/input`, "Procedure", name)) inputs(path, p.input, p.inputs);
    jsonSchema(p.output, `${path}/output`, "Procedure", name);
  }
  for (const [key, s] of Object.entries(plan.schemas)) {
    const bad = (what: string) => out.push(refused(`plan#/schemas/${key}`, `SQL_SHAPE: ${what}`));
    const fields = s.fields ?? {};
    // the columns are the JSON Schema's properties, typed and named as the CLI writes them (no two that fold to one name)
    if (jsonSchema(s.schema, `plan#/schemas/${key}/schema`, "Schema", typeof s.name === "string" ? s.name : key)) {
      const props = Object.keys(s.schema.properties ?? {});
      if (!sameMap(fields, fieldTypes(s.schema)) || Object.keys(fields).length !== props.length) bad("fields are the JSON Schema's properties, typed as the CLI types them");
      if (!sameMap(s.names, Object.fromEntries(props.map((n) => [n.toLowerCase(), n])))) bad("names map each field to its property's name");
    }
    // a column storage creates: a declared field that is one column (a geo field is two), or a native one (`status` only when publishing)
    const column = (x: unknown) => isName(x) && (Object.hasOwn(fields, x) ? fields[x] !== "geo" : NATIVE.has(x) && (x !== "status" || !!s.publishing));
    if (!isName(key) || typeof s.name !== "string" || s.name.toLowerCase() !== key) bad("a Schema's key is its name in lower case");
    for (const [f, t] of Object.entries(fields)) if (!isName(f) || NATIVE.has(f) || !isFieldType(t)) bad(`field ${JSON.stringify(f)} is a lower-case name with a Mantle type`);
    const clash = storageColumnClash(fields);
    if (clash) bad(`field ${JSON.stringify(clash)} is a column storage creates for another purpose`);
    for (const [f, n] of Object.entries(s.names ?? {})) if (!Object.hasOwn(fields, f) || typeof n !== "string" || n.toLowerCase() !== f) bad(`names[${JSON.stringify(f)}] names a field`);
    if (s.scope !== undefined && !(isName(s.scope) && Object.hasOwn(fields, s.scope))) bad("scope is a declared field");
    if ((s.ttl === undefined) !== (s.ttlSeconds === undefined)) bad("ttl and ttlSeconds go together");
    // as the CLI requires: a declared date-time field. A native column (`version`, `created_at`) would expire every row at once
    if (s.ttl !== undefined && !(isName(s.ttl) && Object.hasOwn(fields, s.ttl) && fields[s.ttl] === "timestamptz")) bad("ttl is a declared date-time (timestamptz) field");
    if (s.ttlSeconds !== undefined && !isTtlSeconds(s.ttlSeconds)) bad(`ttlSeconds is a whole number of seconds from 0 to ${MAX_TTL_SECONDS}`);
    // as the CLI requires: search columns are declared text fields, unique and index columns scalar columns storage creates
    if (s.search !== undefined && !(Array.isArray(s.search) && s.search.length && s.search.every((x) => isName(x) && fields[x] === "text"))) bad("search columns are declared text fields");
    for (const cols of [...(s.unique ?? []), ...(s.indexes ?? [])]) if (!Array.isArray(cols) || !cols.length || !cols.every((x) => column(x) && fields[x as string] !== "json")) bad("unique and index columns are scalar columns storage creates (no geo or json field, status only when publishing)");
  }
  for (const c of sideTableClashes(plan.schemas)) out.push(refused(`plan#/schemas/${c.schema}`, `SQL_SHAPE: ${c.message}`));

  for (const [name, v] of Object.entries(plan.views)) {
    const path = `plan#/views/${name}`;
    // an output Store decodes and Admin labels as a Schema field: the Schema and the field (or a native timestamp) exist
    for (const [k, c] of Object.entries(v.columns ?? {})) {
        const s = c && typeof c.schema === "string" && Object.hasOwn(plan.schemas, c.schema) ? plan.schemas[c.schema]! : undefined;
        if (!s || typeof c.field !== "string" || !(Object.hasOwn(s.fields ?? {}, c.field) || Object.hasOwn(NATIVE_OUTPUT_TYPES, c.field)))
          out.push(refused(`${path}/columns`, `SQL_SHAPE: columns[${JSON.stringify(k)}] names a Schema and one of its fields`));
      }
    // a shared cache, as the manifest checks it: REST sends it to anonymous callers, so it must not hold a caller- or time-dependent answer
    if (v.sharedMaxAge !== undefined) {
      const m = v.sharedMaxAge as unknown;
      if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 86_400 || v.surface !== "public" || v.requires)
        out.push(refused(`${path}/sharedMaxAge`, "VIEW_CACHE_INVALID: an integer from 1 to 86400, on an unguarded public View"));
    }
    // Admin's list, as the CLI checks it: an object of name lists, on a staff View
    if (v.uiSchema !== undefined) {
      const problem = checkViewAdminUi({ spec: { surface: v.surface, uiSchema: v.uiSchema } } as unknown as ViewManifest).problems[0];
      if (problem) out.push(refused(`${path}${problem.pointer.replace(/^\/spec/, "")}`, `VIEW_UI_INVALID: ${problem.message}`));
    }
  }

  if (schemasOk) out.push(...graphChecks(plan));

  // the tools an MCP surface registers: a name two of them fold to, or a View input the tool reserves, fails the surface's build
  for (const surface of ["public", "staff"] as const) {
    try {
      mcpTools(plan, surface);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      out.push(refused(`plan#/mcp/${surface}`, `MCP_TOOL_INVALID: ${e.message}`));
    }
  }
  return out;
}
