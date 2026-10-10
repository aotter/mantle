/**
 * Generate-time lowering (ADR-0044). `mantle generate` runs the runtime's own pipeline (dialect check, policy, the dialect's printer)
 * over every View and inline Procedure and records the printed statements in `plan.lowered`. At boot, `seedPlan` puts "lowered
 * Compiled" entries into the compile cache and the paged cache (`run.ts`): the executors run the printed text, and the policy AST
 * is built, through the ordinary compile path, only if a shape that was not lowered needs it. So the first call of a sealed View or
 * inline Procedure in a cold isolate does no dialect check, no `applyPolicy` and no print.
 *
 * One printer: statements are printed through `dialect.print`, the function the dialect's executor prints with, never a copy.
 * The cache is keyed by the plan's own objects and the dialect object, so a seed serves the runtime (and the one storage adapter,
 * whose dialect object it is) that booted this plan; a second adapter compiles for itself.
 */
import { planFingerprint, type LoweredPage, type LoweredStatement, type LoweredView, type PlanLowered, type RuntimePlan, type SqlNode as N } from "../../spec/domain/index.js";
import type { MantleDialect, StorageSchema } from "../dialect.js";
import { lifecycleHookSets } from "../runtime/hooks.js";
import { MANTLE_VERSION } from "../version.js";
import { schemaColumns } from "./allowlist.js";
import { writeTarget } from "./ast.js";
import { compileProgram, type CompileContext } from "./compile.js";
import type { BindSpec, Compiled, Mode } from "./policy.js";
import { compiledKey, pageShape, pagedOf, seedCompiled, seedPaged, type Paged, type Program } from "./run.js";

type Env = { readonly dialect: MantleDialect; readonly schemas: Readonly<Record<string, StorageSchema>> };
type Warn = (message: string) => void;
type Body = Omit<RuntimePlan, "fingerprint" | "lowered">;

export type LoweringStatus = "used" | "absent" | "restricted" | "mantle-version" | "dialect" | "unsupported";

const VIEW_MODES = ["caller", "public", "trusted"] as const;
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
export function lowerView(env: Env, p: Pick<Program, "inputs" | "ir">, mode: Mode, columns = schemaColumns(env.schemas), warn?: Warn, at = ""): LoweredView | undefined {
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
  for (const cursor of [undefined, ...(nkeys ? [Array<unknown>(nkeys).fill(0)] : [])]) {
    try {
      const pg = pagedOf(env, c, cursor, undefined);
      paged[pageShape(nkeys, cursor, undefined)] = { sql: print(pg.ast, env.schemas), sources: pg.sources, ...(pg.flat ? { flat: true as const } : {}), names: pg.names, nkeys: pg.nkeys };
    } catch (e) {
      warn?.(`${at} (${mode}, ${cursor ? "next page" : "first page"}): ${message(e)}`); // the same refusal comes at run time
    }
  }
  return { ...stmtOf(c, print(c.ast, env.schemas)), nkeys, paged };
}

/** One inline Procedure under one mode (flavour "all", with the plan's after hooks as `returning`), printed. Undefined when the runtime would refuse it. */
export function lowerProcedure(env: Env, p: Pick<Program, "inputs" | "ir">, mode: Mode, returning: ReadonlySet<string> | undefined, columns = schemaColumns(env.schemas), warn?: Warn, at = ""): LoweredStatement[] | undefined {
  try {
    const print = printer(env.dialect);
    return compileProgram(p.ir, { dialect: env.dialect, schemas: env.schemas, columns, inputs: p.inputs, kind: "procedure", mode, returning }).map((c) => stmtOf(c, print(c.ast, env.schemas)));
  } catch (e) {
    warn?.(`${at} (${mode}): ${message(e)}`);
    return undefined;
  }
}

/** Lowers every View and inline Procedure of a plan for `dialect`, which must have `print`. A program the runtime would refuse is left out and named in `warnings`. */
export function lowerPlan(plan: Body, dialect: MantleDialect): { lowered: PlanLowered; warnings: string[] } {
  const warnings: string[] = [];
  const warn: Warn = (m) => warnings.push(m);
  const env: Env = { dialect, schemas: plan.schemas };
  const columns = schemaColumns(plan.schemas);
  const { before, after } = lifecycleHookSets(plan);
  const returning = before.size || after.size ? after : undefined; // as boot passes `lifecycle?.after`

  const views = Object.entries(plan.views).flatMap(([name, v]) => {
    const modes = v.surface === "public" ? (["public"] as const) : (["caller", "trusted"] as const);
    const lowered = Object.fromEntries(modes.flatMap((mode) => { const x = lowerView(env, { inputs: v.inputs, ir: v.stmts }, mode, columns, warn, `plan#/views/${name}`); return x ? [[mode, x]] : []; }));
    return Object.keys(lowered).length ? [[name, lowered]] : [];
  });
  const procedures = Object.entries(plan.procedures).flatMap(([name, proc]) => {
    if (!("sql" in proc.handler)) return [];
    const { inputs } = proc, ir = proc.handler.sql.stmts;
    const lowered = Object.fromEntries(PROCEDURE_MODES.flatMap((mode) => { const x = lowerProcedure(env, { inputs, ir }, mode, returning, columns, warn, `plan#/procedures/${name}`); return x ? [[mode, x]] : []; }));
    return Object.keys(lowered).length ? [[name, lowered]] : [];
  });
  return { lowered: { mantle: MANTLE_VERSION, dialect: { name: dialect.name, version: dialect.version, key: dialect.lowerKey ?? "" }, views: Object.fromEntries(views), procedures: Object.fromEntries(procedures) }, warnings };
}

/**
 * The plan with its lowered section and a fingerprint that covers it. A dialect without `print`, or a restricted one, lowers nothing: the plan
 * comes back as it is. The key order of the plan is kept (`lowered` goes last), so a regenerated plan.json diffs only where it changed.
 */
export async function withLowering(plan: RuntimePlan, dialect: MantleDialect): Promise<{ plan: RuntimePlan; warnings: string[] }> {
  if (!dialect.print || dialect.restricted) return { plan, warnings: [] };
  const { lowered: _old, ...rest } = plan;
  const { fingerprint: _f, ...body } = rest;
  const { lowered, warnings } = lowerPlan(body, dialect);
  const fingerprint = await planFingerprint({ ...body, lowered });
  const keys = Object.keys(rest);
  return { plan: { ...Object.fromEntries(keys.map((k) => [k, k === "fingerprint" ? fingerprint : (rest as Record<string, unknown>)[k]])), lowered } as unknown as RuntimePlan, warnings };
}

/** Whether, and if not why not, this runtime uses the plan's lowered statements. The order is the order of the reasons that matter to an operator. */
export function loweringStatus(plan: RuntimePlan, dialect: MantleDialect): LoweringStatus {
  const l = plan.lowered;
  if (!l) return "absent";
  if (dialect.restricted) return "restricted"; // an operator's refusals run on every program (ADR-0037 decision 4)
  if (!dialect.print) return "unsupported";
  if (l.mantle !== MANTLE_VERSION) return "mantle-version";
  if (l.dialect?.name !== dialect.name || l.dialect.version !== dialect.version || l.dialect.key !== (dialect.lowerKey ?? "")) return "dialect";
  return "used";
}

// ---- seeding -------------------------------------------------------------------------------------------------------

const KINDS = new Set(["read", "row", "set"]);
function checkStatement(s: LoweredStatement, where: string): void {
  if (!s || typeof s.sql !== "string" || !Array.isArray(s.binds) || !KINDS.has(s.kind)) throw new Error(`${where} is not a lowered statement`);
}

/** The compile of a program, once, on first use. */
const lazily = <T>(make: () => T) => { let memo: { v: T } | undefined; return () => (memo ??= { v: make() }).v; };

/** A Compiled whose text is printed: its policy AST is `real().ast`, computed on first access and only then. */
function loweredCompiled(s: LoweredStatement, real: () => Compiled, nkeys?: number): Compiled {
  const c = {
    binds: s.binds as BindSpec[], kind: s.kind, ...(s.schema ? { schema: s.schema } : {}), ...(s.verb ? { verb: s.verb } : {}),
    hooked: !!s.hooked, publish: !!s.publish,
    printed: { sql: s.sql, returns: !!s.returns, ...(s.target ? { target: s.target } : {}) },
    ...(nkeys === undefined ? {} : { nkeys }),
  } as unknown as Compiled;
  Object.defineProperty(c, "ast", { enumerable: true, configurable: false, get: () => real().ast });
  return c;
}

function loweredPaged(page: LoweredPage, ast: () => N): Paged {
  if (!page || typeof page.sql !== "string" || !Array.isArray(page.sources) || !Array.isArray(page.names) || typeof page.nkeys !== "number") throw new Error("a paged statement is malformed");
  const p = { sources: page.sources, flat: !!page.flat, names: page.names, nkeys: page.nkeys, printed: { sql: page.sql, returns: false } } as unknown as Paged;
  Object.defineProperty(p, "ast", { enumerable: true, configurable: false, get: ast });
  return p;
}

/** The cursor a page shape stands for: `-` none, `vv=` all keys non-null (Core reads only that pattern of it). Any other shape is not one `lowerView` writes. */
function cursorOf(shape: string, nkeys: number): readonly unknown[] | undefined {
  const pattern = (JSON.parse(shape) as [string])[0];
  if (pattern === "-") return undefined;
  if (pattern === `${"v".repeat(nkeys)}=`) return Array<unknown>(nkeys).fill(0);
  throw new Error(`page shape ${shape} is not a lowered shape`);
}

/**
 * Seeds the compile cache and the paged cache from `plan.lowered`, which `loweringStatus` said is usable. Every entry is built before
 * any is installed, and a malformed or unmatched one abandons the whole seed with a warning: boot never fails here, the programs just
 * compile on first use as they do without `lowered`. `plan.views`, `plan.procedures` and `plan.schemas` must be the objects the Store
 * and the runtime run with, and `dialect` the storage's own, because the cache is keyed by them.
 */
export function seedPlan(plan: RuntimePlan, dialect: MantleDialect, returning: ReadonlySet<string> | undefined): void {
  try {
    const l = plan.lowered!;
    const env: Env = { dialect, schemas: plan.schemas };
    const installs: (() => void)[] = [];
    for (const [name, modes] of Object.entries(l.views)) {
      const v = Object.hasOwn(plan.views, name) ? plan.views[name]! : undefined;
      if (!v) throw new Error(`lowered View '${name}' is not a View of the plan`);
      const p = { inputs: v.inputs, ir: v.stmts };
      for (const [mode, lv] of Object.entries(modes)) {
        if (!(VIEW_MODES as readonly string[]).includes(mode)) throw new Error(`lowered View '${name}' has the unknown mode '${mode}'`);
        checkStatement(lv, `lowered View '${name}' (${mode})`);
        const compile = lazily(() => compileProgram(v.stmts, { dialect, schemas: plan.schemas, inputs: v.inputs, kind: "view", mode: mode as Mode } satisfies CompileContext)[0]!);
        const c0 = loweredCompiled(lv, compile, lv.nkeys);
        const pageds = Object.entries(lv.paged ?? {}).map(([shape, page]) => {
          const cursor = cursorOf(shape, lv.nkeys);
          return [shape, loweredPaged(page, () => pagedOf(env, compile(), cursor, undefined).ast)] as const;
        });
        installs.push(() => {
          const [c] = seedCompiled(env, p, compiledKey("view", mode, undefined, undefined, "view"), [c0]);
          if (c === c0) for (const [shape, paged] of pageds) seedPaged(c0, shape, paged);
        });
      }
    }
    for (const [name, modes] of Object.entries(l.procedures)) {
      const proc = Object.hasOwn(plan.procedures, name) ? plan.procedures[name]! : undefined;
      if (!proc || !("sql" in proc.handler)) throw new Error(`lowered Procedure '${name}' is not an inline Procedure of the plan`);
      const p = { inputs: proc.inputs, ir: proc.handler.sql.stmts };
      for (const [mode, stmts] of Object.entries(modes)) {
        if (!(PROCEDURE_MODES as readonly string[]).includes(mode)) throw new Error(`lowered Procedure '${name}' has the unknown mode '${mode}'`);
        if (!Array.isArray(stmts) || stmts.length !== p.ir.length) throw new Error(`lowered Procedure '${name}' (${mode}) does not match its statements`);
        stmts.forEach((s, i) => checkStatement(s, `lowered Procedure '${name}' (${mode}) statement ${i}`));
        const full = lazily(() => compileProgram(p.ir, { dialect, schemas: plan.schemas, inputs: p.inputs, kind: "procedure", mode: mode as Mode, returning }));
        const entries = stmts.map((s, i) => loweredCompiled(s, () => full()[i]!));
        installs.push(() => { seedCompiled(env, p, compiledKey("procedure", mode, returning, undefined, "all"), entries); });
      }
    }
    for (const install of installs) install();
  } catch (e) {
    console.warn(`[mantle boot] lowered statements not used (${message(e)}); regenerate the plan with this Mantle (\`mantle generate\`)`);
  }
}
