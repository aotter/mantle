#!/usr/bin/env node
// Cold-isolate benchmark for generate-time lowering (ADR-0044). Not part of `pnpm check`.
//
//   pnpm --filter @aotter/mantle build
//   node scripts/bench-cold-start.mjs --plan <plan.json> --calls view:catalog,view:search-items:'{"q":"a"}',proc:restock:'{"id":"x","stock":1}' \
//     [--caller <subject>[:<role>] | anonymous] [--seed <ops.json>] [--runs 30]
//
// A fresh `node` process is the closest local stand-in for a new isolate. Each run boots the plan on a copy of a converged
// SQLite file (node:sqlite) and times, per call, the first and the second execution: wall time, SQL time (the driver's own
// calls) and Mantle CPU = wall - SQL. Two variants alternate: A is the plan as `mantle generate` wrote it (with `lowered`), B is
// the same plan with `lowered` deleted and the fingerprint recomputed, which is the compile-cache path of the same build.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "packages/mantle/dist");
const SELF = import.meta.filename;

// ---- child: one cold process ------------------------------------------------------------------------------------------
async function child(args) {
  const { plan: planFile, db: dbFile, calls, caller: who, seed, mode } = args;
  const { createMantleRuntime } = await import(pathToFileURL(join(DIST, "core/index.js")).href);
  const { sqliteStorage } = await import(pathToFileURL(join(DIST, "d1/index.js")).href);
  const { planFingerprint } = await import(pathToFileURL(join(DIST, "spec/index.js")).href);
  const { DatabaseSync } = await import("node:sqlite");
  const { plan } = JSON.parse(readFileSync(planFile, "utf8"));

  if (mode === "fingerprint") {
    const { fingerprint: _f, ...body } = plan;
    const t0 = performance.now();
    await planFingerprint(body);
    return { fingerprintMs: performance.now() - t0 };
  }

  const db = new DatabaseSync(dbFile);
  let sqlMs = 0;
  const timed = (f) => { const t = performance.now(); try { return f(); } finally { sqlMs += performance.now() - t; } };
  // node:sqlite binds only anonymous `?`: a numbered `?N` becomes `?` with its value in the order it appears
  const prepare = (s) => { const binds = []; const sql = s.sql.replace(/\?(\d+)/g, (_, n) => (binds.push(s.binds[Number(n) - 1] ?? null), "?")); return { sql, binds }; };
  const driver = {
    batch: async (stmts) => timed(() => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => { const { sql, binds } = prepare({ binds: [], ...s }); return { rows: db.prepare(sql).all(...binds) }; });
        db.exec("COMMIT");
        return out;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }),
    all: async (s) => timed(() => { const { sql, binds } = prepare({ binds: [], ...s }); return db.prepare(sql).all(...binds); }),
  };
  const refs = Object.values(plan.procedures).flatMap((p) => ("ref" in p.handler ? [p.handler.ref] : []));
  const handlers = Object.fromEntries(refs.map((r) => [r, () => ({})]));

  const t0 = performance.now();
  const runtime = await createMantleRuntime({ plan, handlers, storage: sqliteStorage(driver), schedules: true });
  const bootMs = performance.now() - t0;
  const caller = who === "anonymous" ? { kind: "anonymous" } : { kind: "user", subject: who.split(":")[0], role: who.split(":")[1] ?? null, scopes: [], credential: "session", credentialId: null, clientId: null };

  if (mode === "init") {
    if (seed) await runtime.store.write(JSON.parse(readFileSync(seed, "utf8")));
    return { ok: true, lowered: runtime.bootReport().lowered };
  }
  const run = (c) => {
    const [kind, name, ...rest] = c.split(":");
    const input = rest.length ? JSON.parse(rest.join(":")) : undefined;
    return kind === "view" ? () => runtime.store.as(caller).view(name, input ? { input } : {})
      : () => runtime.invokeProcedure({ procedure: name, input: input ?? {}, caller, cause: { kind: "http", id: `bench:${name}` } });
  };
  const results = [];
  for (const c of calls) {
    const f = run(c);
    const measure = async () => { sqlMs = 0; const t = performance.now(); let error; try { await f(); } catch (e) { error = String(e?.diagnostic?.message ?? e?.message ?? e); } const wall = performance.now() - t; return { wall, sql: sqlMs, cpu: wall - sqlMs, ...(error ? { error } : {}) }; };
    const first = await measure();
    const second = await measure();
    results.push({ call: c, first, second });
  }
  return { bootMs, lowered: runtime.bootReport().lowered, results };
}

// ---- parent -----------------------------------------------------------------------------------------------------------
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)];
const fmt = (n) => n.toFixed(1);

function spawn(args) {
  const r = spawnSync(process.execPath, ["--no-warnings", SELF, "--child", JSON.stringify(args)], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

async function parent() {
  const { values } = parseArgs({ options: { plan: { type: "string" }, calls: { type: "string" }, caller: { type: "string", default: "anonymous" }, seed: { type: "string" }, runs: { type: "string", default: "30" } } });
  if (!values.plan || !values.calls) throw new Error("usage: bench-cold-start.mjs --plan <plan.json> --calls view:<name>[:inputJSON],proc:<name>[:inputJSON] [--caller <subject>[:<role>]] [--seed <ops.json>] [--runs 30]");
  const runs = Number(values.runs);
  const calls = values.calls.split(/,(?=view:|proc:)/);
  const dir = mkdtempSync(join(tmpdir(), "mantle-bench-"));
  try {
    const { sourceHash, plan } = JSON.parse(readFileSync(values.plan, "utf8"));
    if (!plan.lowered) throw new Error("the plan has no lowered section: run `mantle generate` with this build");
    // B: the same plan without lowered statements, sealed again
    const { planFingerprint } = await import(pathToFileURL(join(DIST, "spec/index.js")).href);
    const { fingerprint: _f, lowered: _l, ...body } = plan;
    const stripped = { ...body, fingerprint: await planFingerprint(body) };
    const variants = { A: { label: "lowered", file: join(dir, "a.json"), db: join(dir, "a.db") }, B: { label: "compile cache", file: join(dir, "b.json"), db: join(dir, "b.db") } };
    writeFileSync(variants.A.file, JSON.stringify({ sourceHash, plan }));
    writeFileSync(variants.B.file, JSON.stringify({ sourceHash, plan: stripped }));
    const bytes = { A: readFileSync(variants.A.file).length, B: readFileSync(variants.B.file).length };
    for (const v of Object.values(variants)) spawn({ mode: "init", plan: v.file, db: v.db, calls, caller: values.caller, seed: values.seed });

    const samples = { A: [], B: [] }, fingerprint = { A: [], B: [] };
    for (let i = 0; i < runs; i++) for (const key of i % 2 ? ["B", "A"] : ["A", "B"]) {
      const v = variants[key];
      const copy = join(dir, `run-${key}.db`);
      copyFileSync(v.db, copy);
      samples[key].push(spawn({ plan: v.file, db: copy, calls, caller: values.caller }));
      fingerprint[key].push(spawn({ mode: "fingerprint", plan: v.file }).fingerprintMs);
    }

    const out = [`plan: ${values.plan}`, `runs: ${runs} fresh processes per variant, alternating; node ${process.version}`, ""];
    out.push(`plan.json bytes: lowered ${bytes.A}, compile cache ${bytes.B} (+${((bytes.A / bytes.B - 1) * 100).toFixed(0)}%)`);
    out.push(`bootReport().lowered: ${[...new Set(samples.A.map((s) => s.lowered))].join(",")} (A), ${[...new Set(samples.B.map((s) => s.lowered))].join(",")} (B)`);
    out.push(`boot ms (median / p95): lowered ${fmt(median(samples.A.map((s) => s.bootMs)))} / ${fmt(p95(samples.A.map((s) => s.bootMs)))}, compile cache ${fmt(median(samples.B.map((s) => s.bootMs)))} / ${fmt(p95(samples.B.map((s) => s.bootMs)))}`);
    out.push(`planFingerprint ms, cold (median): lowered ${fmt(median(fingerprint.A))}, compile cache ${fmt(median(fingerprint.B))}`, "");
    out.push("| call | execution | lowered median | lowered p95 | compile cache median | compile cache p95 |", "| --- | --- | ---: | ---: | ---: | ---: |");
    calls.forEach((c, i) => {
      for (const when of ["first", "second"]) {
        const a = samples.A.map((s) => s.results[i][when].cpu), b = samples.B.map((s) => s.results[i][when].cpu);
        out.push(`| ${c.split(":").slice(0, 2).join(":")} | ${when} | ${fmt(median(a))} | ${fmt(p95(a))} | ${fmt(median(b))} | ${fmt(p95(b))} |`);
      }
    });
    const errors = samples.A.flatMap((s) => s.results.flatMap((r) => [r.first.error, r.second.error].filter(Boolean)));
    if (errors.length) out.push("", `errors in A (a call that failed is timed as it failed): ${[...new Set(errors)].join("; ")}`);
    out.push("", "Mantle CPU in ms = wall - the driver's SQL time. The first call of a cold process includes V8's first execution of every function it reaches.");
    console.log(out.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const i = process.argv.indexOf("--child");
if (i > -1) process.stdout.write(JSON.stringify(await child(JSON.parse(process.argv[i + 1]))));
else await parent();
