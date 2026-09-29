// CLI side of ADR-0034: SQL text -> IR. libpg-query parses; validation runs on the raw AST (so a
// refusal has a source offset); then locations are stripped and every relation is tagged.
// Nothing in a Worker imports this file: libpg-query declares a 128 MiB WASM memory.
import { parse } from 'libpg-query';
import type { Ctx, Diagnostic, N } from './types.ts';
import { Refused } from './types.ts';
import { stripLocations, tagRelations, validateProgram } from './validate.ts';

/** the PostgreSQL grammar version the plan records (libpg-query 18: PG 18.0.4) */
export const PG_GRAMMAR = 180004;

export type Lowered = { stmts: N[]; warnings: Diagnostic[] };

/** UTF-8 byte offset (what libpg-query reports) -> line, column (1-based) and the token there. */
export function locate(source: string, byteOffset: number): Pick<Diagnostic, 'offset' | 'line' | 'column' | 'token'> {
  const bytes = Buffer.from(source, 'utf8');
  const prefix = bytes.subarray(0, byteOffset).toString('utf8');
  const lines = prefix.split('\n');
  const rest = source.slice(prefix.length);
  const token = /^("[^"]*"|'[^']*'|[\w.$]+|\S)/.exec(rest)?.[0];
  return { offset: prefix.length, line: lines.length, column: lines.at(-1)!.length + 1, token };
}

export function toDiagnostic(e: Refused, source: string): Diagnostic {
  return { code: e.code, message: e.message, ...(e.offset === undefined ? {} : locate(source, e.offset)) };
}

/** CAST(x AS int) truncates toward zero in SQLite where PostgreSQL rounds: warn, do not rewrite. */
function castWarnings(raw: N[], source: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const visit = (v: any) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const t = v.TypeCast;
    if (t) {
      const name = t.typeName.names.at(-1).String.sval;
      if ((name === 'int4' || name === 'int8') && !t.arg?.A_Const)
        out.push({ code: 'SQL_CAST_TRUNC', message: `CAST to ${name} truncates toward zero in SQLite; PostgreSQL rounds (2.7 gives 2 here, 3 there). Write round(x) first if you mean PostgreSQL's result`, ...locate(source, t.location ?? 0) });
    }
    Object.values(v).forEach(visit);
  };
  visit(raw);
  return out;
}

/** Throws `Refused` (with an offset when the AST has one) or returns the IR. */
export async function lower(sql: string, ctx: Omit<Ctx, 'source'>): Promise<Lowered> {
  let tree;
  try {
    tree = await parse(sql);
  } catch (e: any) {
    throw new Refused('SQL_SYNTAX', String(e.message).replace(/^.*?:\s*/, ''), typeof e.cursorPosition === 'number' && e.cursorPosition >= 0 ? Buffer.byteLength(sql.slice(0, Math.max(0, e.cursorPosition - 1))) : undefined);
  }
  const raw = tree.stmts.map((s: N) => s.stmt);
  const locs = tree.stmts.map((s: N) => s.stmt_location);
  const tagged = tagRelations(raw);
  validateProgram(tagged, { ...ctx, source: sql }, locs);
  return { stmts: stripLocations(tagged), warnings: castWarnings(raw, sql) };
}

/** `lower`, but a refusal becomes a Diagnostic (what the CLI prints). */
export async function tryLower(sql: string, ctx: Omit<Ctx, 'source'>): Promise<{ ok: true; ir: Lowered } | { ok: false; diagnostic: Diagnostic }> {
  try {
    return { ok: true, ir: await lower(sql, ctx) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, diagnostic: toDiagnostic(e, sql) };
    throw e;
  }
}
