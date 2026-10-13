/** Generate-time lowering through the checked SQL compiler and dialect printer. */
import { type LoweredPage, type LoweredStatement, type LoweredView, type PlanLowered, type RuntimePlan, type SqlNode as N } from "../../spec/domain/index.js";
import type { MantleDialect, StorageSchema } from "../dialect.js";
import { lifecycleHookSets } from "../runtime/hooks.js";
import { MANTLE_VERSION } from "../version.js";
import { schemaColumns } from "./allowlist.js";
import { writeTarget } from "./ast.js";
import { compileProgram } from "./compile.js";
import type { Compiled, Mode } from "./policy.js";
import { pageShape, pagedOf, type Paged, type Program } from "./run.js";

type Env = { readonly dialect: MantleDialect; readonly schemas: Readonly<Record<string, StorageSchema>> };
type Warn = (message: string) => void;
type Project = (ast: N, page?: Paged) => N;
export interface LoweringOptions {
  readonly mode?: (mode: Mode) => Mode;
  readonly pageQuery?: (ast: N, name: string) => N;
  readonly project?: (ast: N, kind: "view" | "procedure", name: string, page?: Paged) => N;
}

type Body = Omit<RuntimePlan, "fingerprint" | "lowered">;

const PROCEDURE_MODES = ["caller", "trusted"] as const;

const returningClause = (ast: N): boolean => Boolean(ast[Object.keys(ast)[0]!]?.returningClause);

const stmtOf = (c: Compiled, sql: string): LoweredStatement => {
  const target = writeTarget(c.ast);
  return {
    sql, binds: c.binds, kind: c.kind,
    ...(c.schema ? { schema: c.schema } : {}), ...(c.verb ? { verb: c.verb } : {}),
    ...(c.hooked ? { hooked: true as const } : {}), ...(c.publish ? { publish: true as const } : {}),
    ...(returningClause(c.ast) ? { returns: true as const } : {}), ...(target ? { target } : {}),
  };
};

const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]! : String(e));
const printer = (dialect: MantleDialect) => dialect.print!.bind(dialect);

/** One View under one mode, printed, with its paged statements for the default shapes (no cursor, and a cursor whose every key is non-null). Undefined when the runtime would refuse the View. */
export function lowerView(env: Env, p: Pick<Program, "inputs" | "ir">, mode: Mode, columns = schemaColumns(env.schemas), warn?: Warn, at = "", project?: Project, pageQuery?: (ast: N) => N): LoweredView | undefined {
  const print = printer(env.dialect);
  let c: Compiled;
  try {
    [c] = compileProgram(p.ir, { dialect: env.dialect, schemas: env.schemas, columns, inputs: p.inputs, kind: "view", mode }) as [Compiled];
  } catch (e) {
    warn?.(`${at} (${mode}): ${message(e)}`);
    return undefined;
  }
  const nkeys: number = c.ast.SelectStmt.sortClause?.length ?? 0;
  const paged: Record<string, LoweredPage> = {};
  const pageCompiled = pageQuery ? { ...c, ast: pageQuery(c.ast) } : c;
  for (const cursor of [undefined, ...(nkeys ? [Array<unknown>(nkeys).fill(0)] : [])]) {
    try {
      const pg = pagedOf(env, pageCompiled, cursor, undefined);
      paged[pageShape(nkeys, cursor, undefined)] = { sql: print(project?.(pg.ast, pg) ?? pg.ast, env.schemas), sources: pg.sources, ...(pg.flat ? { flat: true as const } : {}), names: pg.names, nkeys: pg.nkeys };
    } catch (e) {
      warn?.(`${at} (${mode}, ${cursor ? "next page" : "first page"}): ${message(e)}`); // the same refusal comes at run time
    }
  }
  return { ...stmtOf(c, print(project?.(c.ast) ?? c.ast, env.schemas)), nkeys, paged };
}

/** One inline Procedure under one mode (flavour "all", with the plan's after hooks as `returning`), printed. Undefined when the runtime would refuse it. */
export function lowerProcedure(env: Env, p: Pick<Program, "inputs" | "ir">, mode: Mode, returning: ReadonlySet<string> | undefined, columns = schemaColumns(env.schemas), warn?: Warn, at = "", project?: Project): LoweredStatement[] | undefined {
  try {
    const print = printer(env.dialect);
    return compileProgram(p.ir, { dialect: env.dialect, schemas: env.schemas, columns, inputs: p.inputs, kind: "procedure", mode, returning }).map((c) => stmtOf(c, print(project?.(c.ast) ?? c.ast, env.schemas)));
  } catch (e) {
    warn?.(`${at} (${mode}): ${message(e)}`);
    return undefined;
  }
}

/** Lowers every View and inline Procedure of a plan for `dialect`, which must have `print`. A program the runtime would refuse is left out and named in `warnings`. */
export function lowerPlan(plan: Body, dialect: MantleDialect, options: LoweringOptions = {}): { lowered: PlanLowered; warnings: string[] } {
  const warnings: string[] = [];
  const warn: Warn = (m) => warnings.push(m);
  const env: Env = { dialect, schemas: plan.schemas };
  const columns = schemaColumns(plan.schemas);
  const { before, after } = lifecycleHookSets(plan);
  const returning = before.size || after.size ? after : undefined; // as boot passes `lifecycle?.after`

  const views = Object.entries(plan.views).flatMap(([name, v]) => {
    const modes = v.surface === "public" ? (["public"] as const) : (["caller", "trusted"] as const);
    const lowered = Object.fromEntries(modes.flatMap((mode) => { const x = lowerView(env, { inputs: v.inputs, ir: v.stmts }, options.mode?.(mode) ?? mode, columns, warn, `plan#/views/${name}`, options.project && ((ast, page) => options.project!(ast, "view", name, page)), options.pageQuery && (ast => options.pageQuery!(ast, name))); return x ? [[mode, x]] : []; }));
    return Object.keys(lowered).length ? [[name, lowered]] : [];
  });
  const procedures = Object.entries(plan.procedures).flatMap(([name, proc]) => {
    if (!("sql" in proc.handler)) return [];
    const { inputs } = proc, ir = proc.handler.sql.stmts;
    const lowered = Object.fromEntries(PROCEDURE_MODES.flatMap((mode) => { const x = lowerProcedure(env, { inputs, ir }, options.mode?.(mode) ?? mode, returning, columns, warn, `plan#/procedures/${name}`, options.project && (ast => options.project!(ast, "procedure", name))); return x ? [[mode, x]] : []; }));
    return Object.keys(lowered).length ? [[name, lowered]] : [];
  });
  return { lowered: { mantle: MANTLE_VERSION, dialect: { name: dialect.name, version: dialect.version, key: dialect.lowerKey ?? "" }, views: Object.fromEntries(views), procedures: Object.fromEntries(procedures) }, warnings };
}
