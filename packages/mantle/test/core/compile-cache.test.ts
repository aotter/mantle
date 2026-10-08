// @ts-nocheck test code over loosely typed IR and rows
/**
 * The compile cache (Core `compileCached`, the paged-AST cache, and each executor's printed-SQL cache) must be invisible: for every
 * printer-corpus View and Procedure, several callers, modes and cursor shapes, the cached path emits exactly the SQL and binds the
 * uncached path does, whichever caller warmed the cache first. The reference is a deep copy of the program (new object identities, so
 * every cache misses) run with `seen` set (which bypasses the compile cache) on an executor of its own.
 */
import { expect, it, vi } from "vitest";
import { d1Dialect } from "../../src/d1/dialect.js";
import { SqliteStoreExecutor } from "../../src/d1/executor.js";
import * as d1Compile from "../../src/d1/compile/index.js";
import { postgresDialect } from "../../src/postgres/index.js";
import { PgStoreExecutor } from "../../src/postgres/executor.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { NOW, program, runProcedure, runView, schemas, useCompileSide } from "../../src/testing/harness.js";
import { corpus } from "../../src/testing/cases/corpus.js";

/** Who runs: bound values only. Policy never reads the caller's identity into the statement's text, only into its binds. */
const CALLERS = [
  { name: "anonymous", uid: null, role: undefined },
  { name: "owner", uid: "o1", role: undefined },
  { name: "staff", uid: "o1", role: "staff" },
  { name: "other scope", uid: "o2", role: "member" },
];
const MODES = ["caller", "public", "trusted"] as const;

/** The paged requests a View can get: the first page, every cursor shape (NULL pattern and length), page sizes, search and filters. */
const PAGES = [
  {},
  { pageSize: 3 },
  { pageSize: 7 },
  { pageSize: 3, cursor: ["a"] },
  { pageSize: 3, cursor: ["a", "b"] },
  { pageSize: 3, cursor: ["a", "b", "c"] },
  { pageSize: 3, cursor: ["a", "b", "c", "d"] },
  { pageSize: 3, cursor: [null] },
  { pageSize: 3, cursor: [null, "b"] },
  { pageSize: 3, cursor: ["a", null] },
  { pageSize: 3, cursor: [null, null] },
  { pageSize: 3, cursor: [1, 2] },
  { pageSize: 3, cursor: [] },
  { pageSize: 3, cursor: ["a", undefined] },
];

function recorder() {
  const log: unknown[] = [];
  const client = {
    query: async (config: { text: string; values?: unknown[] }) => (log.push({ text: config.text, values: config.values }), { rows: [], rowCount: 0, fields: [] }),
    end: async () => undefined,
  };
  return { log, connect: async () => client as never, driver: { batch: async (stmts: { sql: string; binds?: unknown[] }[]) => (log.push(...stmts.map((s) => ({ sql: s.sql, binds: s.binds }))), stmts.map(() => ({ rows: [{ n: 0 }], changes: 0 }))) } as never };
}

const ENGINES = {
  postgres: { dialect: postgresDialect(), compile: pgCompile, executor: (r: ReturnType<typeof recorder>) => new PgStoreExecutor(r.connect, schemas, new Map()) },
  d1: { dialect: d1Dialect, compile: d1Compile, executor: (r: ReturnType<typeof recorder>) => new SqliteStoreExecutor(r.driver) },
};

/** What a request emitted, or how it was refused. */
async function emit(exec: ReturnType<typeof recorder>, run: () => Promise<unknown>) {
  const from = exec.log.length;
  let err: string | undefined;
  try { await run(); } catch (e) { err = String(e.diagnostic?.message ?? e.message); }
  return JSON.stringify({ sent: exec.log.slice(from), err });
}

const bindOf = (c: (typeof CALLERS)[number], input: Record<string, unknown> | undefined) => ({ uid: c.uid, now: NOW, input: input ?? {}, ...(c.role ? { role: c.role } : {}) });

for (const [name, e] of Object.entries(ENGINES)) {
  it(`${name}: the cached path emits the uncached path's SQL and binds, whichever caller warmed it`, async () => {
    useCompileSide(e.compile);
    try {
      let compared = 0;
      for (const base of corpus) {
        const item = e.dialect.nativeSql && base.native ? { ...base, ...base.native } : base;
        const p = await program(item.kind, item.sql, item.inputs ?? {}).catch((x) => (/^SQL_(UNSUPPORTED|FUNCTION|TYPE):/.test(x.message) ? undefined : Promise.reject(x)));
        if (!p) continue;
        const frozen = JSON.stringify(p.ir);
        const pages = item.kind === "view" ? PAGES : [{}];
        // a search and an equality filter on the View's first output, when it names one
        const first = p.ir[0]?.SelectStmt?.targetList?.[0]?.ResTarget;
        const out = first?.name ?? first?.val?.ColumnRef?.fields?.at(-1)?.String?.sval;
        const matches = item.kind === "view" && out ? [{ pageSize: 3, match: { search: { columns: [out], text: "x_1" } } }, { pageSize: 3, cursor: ["a", "b"], match: { search: { columns: [out], text: "y%" }, eq: [{ column: out, value: "q" }] } }, { pageSize: 5, match: { eq: [{ column: out, value: 1 }] } }] : [];
        const requests = [...pages, ...matches];

        // the reference: a program of new identities, run with `seen` (no compile cache) on an executor of its own
        const reference = new Map<string, string>();
        const refSite = (mode: string) => ({ schemas, dialect: e.dialect, executor: undefined as never, mode, seen: new Set() });
        for (const mode of MODES) for (const c of CALLERS) for (const [i, req] of requests.entries()) {
          const rec = recorder();
          const site = { ...refSite(mode), executor: e.executor(rec) };
          const q = structuredClone(p);
          reference.set(`${mode}|${c.name}|${i}`, await emit(rec, () => (item.kind === "view" ? runView(site, q, bindOf(c, item.input), req) : runProcedure(site, q, bindOf(c, item.input)))));
        }

        // warmed by one caller, then another, and the other way round: each on a cold cache of its own, one executor shared throughout
        for (const order of [CALLERS, [...CALLERS].reverse()]) {
          const shared = structuredClone(p);
          for (const mode of MODES) {
            const rec = recorder();
            const site = { schemas, dialect: e.dialect, executor: e.executor(rec), mode };
            // twice over: the second round is all hits
            for (let round = 0; round < 2; round++)
              for (const c of order) for (const [i, req] of requests.entries()) {
                const got = await emit(rec, () => (item.kind === "view" ? runView(site, shared, bindOf(c, item.input), req) : runProcedure(site, shared, bindOf(c, item.input))));
                expect(got, `${item.id} ${mode} ${c.name} request ${i} (${JSON.stringify(req)}) round ${round}`).toBe(reference.get(`${mode}|${c.name}|${i}`));
                compared++;
              }
          }
          // nothing a request did changed the sealed program
          expect(JSON.stringify(shared.ir), `${item.id}: the sealed IR`).toBe(frozen);
        }
      }
      expect(compared).toBeGreaterThan(1000);
    } finally {
      useCompileSide(undefined);
    }
  }, 600_000);
}

it("a sealed View is compiled once per mode, not per request or caller; the probe runs never use the cache", async () => {
  useCompileSide(pgCompile);
  try {
    const check = vi.fn(ENGINES.postgres.dialect.check);
    const dialect = { ...ENGINES.postgres.dialect, check };
    const rec = recorder();
    const executor = ENGINES.postgres.executor(rec);
    const p = await program("view", "SELECT id FROM items ORDER BY id");
    for (const c of CALLERS) for (const req of PAGES.slice(0, 6)) await runView({ schemas, dialect, executor, mode: "caller" }, p, bindOf(c, {}), req).catch(() => undefined);
    expect(check).toHaveBeenCalledTimes(1);
    await runView({ schemas, dialect, executor, mode: "trusted" }, p, bindOf(CALLERS[0], {}));
    expect(check).toHaveBeenCalledTimes(2);
    await runView({ schemas, dialect, executor, mode: "caller", seen: new Set() }, p, bindOf(CALLERS[0], {}));
    await runView({ schemas, dialect, executor, mode: "caller", unsafeNoVisibility: true }, p, bindOf(CALLERS[0], {}));
    expect(check).toHaveBeenCalledTimes(4);
    // another plan's IR, or the same IR under another dialect object, never shares an entry
    await runView({ schemas, dialect: { ...dialect }, executor, mode: "caller" }, p, bindOf(CALLERS[0], {}));
    expect(check).toHaveBeenCalledTimes(5);
  } finally {
    useCompileSide(undefined);
  }
});

it("a request's page size and cursor length cannot grow the cache without bound", async () => {
  useCompileSide(pgCompile);
  try {
    const rec = recorder();
    const dialect = ENGINES.postgres.dialect;
    const executor = ENGINES.postgres.executor(rec);
    const p = await program("view", "SELECT id FROM items ORDER BY id");
    const site = { schemas, dialect, executor, mode: "caller" };
    const request = (n: number) => runView(site, p, bindOf(CALLERS[1], {}), { pageSize: n + 1, cursor: Array.from({ length: n % 5 }, (_x, i) => (i % 2 ? null : "a")) });
    const first = await emit(rec, () => request(0));
    for (let n = 1; n < 400; n++) await request(n);
    // after the cap was passed (and cleared) a shape still gives the statement it gave first
    expect(await emit(rec, () => request(0))).toBe(first);
  } finally {
    useCompileSide(undefined);
  }
});
