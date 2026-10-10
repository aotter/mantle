#!/usr/bin/env node
// Runtime overhang benchmark orchestrator. Never imports Mantle: every measurement runs in child.mjs.
//   node bench/run.mjs <all|cold|warm|check|compare> [options]      (see bench/README.md)
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as decodeJson } from "./lib/codec.mjs";
import { evaluate, failures } from "./lib/check.mjs";
import { cacheFile, prepareFiles, variantHash } from "./lib/prepare.mjs";
import { SCHEMA, compare, renderMarkdown } from "./lib/report.mjs";
import { aggregateCold, aggregateWarm, shuffle } from "./lib/stats.mjs";
import { BENCH_DIR, DEFAULT_APP, OWN_PACKAGE_DIR, findInstalledMantle, loadItems, loadTarget, resolveMantle } from "./lib/target.mjs";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "child.mjs");
const USAGE = `usage: node bench/run.mjs <all|cold|warm|check|compare> [options]
  --app <path>             dir containing mantle.bench.mjs, or the module file (default: bench/fixtures/training)
  --mantle <dir>           the @aotter/mantle package dir to measure (a built checkout's packages/mantle);
                           default: this package for the fixture, the app's installed @aotter/mantle for --app
  --label <name>           variant label (default: <version>@<git sha>)
  --dialect sqlite         only sqlite (node:sqlite) is supported
  --items <p,...>          substring or * glob on item names
  --rounds N --samples N --warmup N   warm settings (all: 3/200/20, check: 1/50/10)
  --time-budget-ms N       per item per round, sampling stops after this once 10 samples exist (default 5000)
  --cold-samples N         fresh processes per item per side, plus 1 discarded (all: 10, check: 3)
  --no-counters            skip the coverage processes
  --out <file.md>          also write the markdown here
  --json <file>            result file (default bench/results/<timestamp>-<label>.json)
  --seed-reset             rebuild the cached database
  --strict-timing          timing violations fail instead of warning
  compare <base.json> <head.json> [--out f.md]`;

const { values: opt, positionals } = (() => {
  try {
    return parseArgs({ allowPositionals: true, options: {
      app: { type: "string" }, mantle: { type: "string" }, label: { type: "string" }, dialect: { type: "string" }, items: { type: "string" },
      rounds: { type: "string" }, samples: { type: "string" }, warmup: { type: "string" }, "time-budget-ms": { type: "string" }, "cold-samples": { type: "string" },
      "no-counters": { type: "boolean" }, out: { type: "string" }, json: { type: "string" }, "seed-reset": { type: "boolean" }, "strict-timing": { type: "boolean" }, help: { type: "boolean", short: "h" },
    } });
  } catch (e) {
    die(`${e.message}\n${USAGE}`, 2);
  }
})();

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}
const log = (message) => console.error(`[bench] ${message}`);

const [mode, ...rest] = positionals;
if (opt.help || !["all", "cold", "warm", "check", "compare"].includes(mode)) die(USAGE, opt.help ? 0 : 2);

if (mode === "compare") {
  if (rest.length !== 2) die("compare needs <base.json> <head.json>", 2);
  const [base, head] = rest.map((p) => JSON.parse(readFileSync(resolve(p), "utf8")));
  for (const d of [base, head]) if (d.schema !== SCHEMA) die(`not a ${SCHEMA} result file`, 2);
  const text = compare(base, head);
  console.log(text);
  if (opt.out) writeFileSync(resolve(opt.out), text);
  process.exit(0);
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) die(`node:sqlite needs Node >= 22.13 (running ${process.versions.node})`, 2);
if (opt.mantle?.includes(",")) die("--mantle takes one package dir: run once per variant and compare the saved JSON files (bench:compare). Interleaved A/B is deferred.", 2);
if (opt.dialect && !["sqlite", "all"].includes(opt.dialect)) die("only --dialect sqlite is supported (postgres is a follow-up)", 2);

/** Spawns child.mjs and returns its `@@BENCH` JSON line. A crash or timeout is reported as { ok: false, error }. */
function runChild(childArgs, timeoutMs = 120_000) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--expose-gc", "--disable-warning=ExperimentalWarning", CHILD, JSON.stringify(childArgs)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith("@@BENCH "));
      if (!line) return done({ ok: false, error: `child ${childArgs.mode} exited ${code} without a result: ${err.slice(-2048) || out.slice(-2048)}` });
      done(JSON.parse(line.slice(8)));
    });
  });
}

const num = (value, fallback) => (value === undefined ? fallback : Number(value));
const check = mode === "check";
const settings = {
  rounds: num(opt.rounds, check ? 1 : 3), samples: num(opt.samples, check ? 50 : 200), warmup: num(opt.warmup, check ? 10 : 20),
  budgetMs: num(opt["time-budget-ms"], check ? 3000 : 5000), coldSamples: num(opt["cold-samples"], check ? 3 : 10), counters: !opt["no-counters"],
};
const wantCold = ["all", "cold", "check"].includes(mode);
const wantWarm = ["all", "warm", "check"].includes(mode);

const app = await loadTarget(opt.app ?? DEFAULT_APP).catch((e) => die(e.message, 2));
const mantleDir = opt.mantle ?? (app.isFixture ? OWN_PACKAGE_DIR : findInstalledMantle(app.dir));
if (!mantleDir) die(`no @aotter/mantle found above ${app.dir}: pass --mantle <package dir>`, 2);
const mantle = (() => { try { return resolveMantle(mantleDir, { label: opt.label }); } catch (e) { return die(e.message, 2); } })();

const allItems = await loadItems(app.config, app.dir);
const patterns = opt.items?.split(",").map((p) => new RegExp(p.includes("*") ? `^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$` : p.replace(/[.+?^${}()|[\]\\*]/g, "\\$&")));
const items = patterns ? allItems.filter((i) => patterns.some((p) => p.test(i.name))) : allItems;
if (!items.length) die(`--items ${opt.items} matches no item (known: ${allItems.map((i) => i.name).join(", ")})`, 2);

// ---- prepare: plan through the real CLI, seeded database ----------------------------------------------------------------------
log(`variant ${mantle.label} (${mantle.dir}); app ${app.config.name}; ${items.length} item(s)`);
const files = prepareFiles({ mantle, target: app, seedReset: opt["seed-reset"], seedVersion: app.config.seedVersion ?? 0 });
const common = { mantle: { core: mantle.entries.core, d1: mantle.entries.d1, dirUrl: mantle.dirUrl }, planPath: files.planPath, dbPath: files.dbPath, configUrl: app.configUrl, configDir: app.dir };
if (files.needsSeed) {
  log("seeding the database (cached afterwards)");
  const partial = `${files.dbPath}.partial`;
  const seeded = await runChild({ ...common, mode: "seed", dbPath: partial }, 600_000);
  if (!seeded.ok) die(`seed failed: ${seeded.error}`);
  renameSync(partial, files.dbPath);
}

// ---- record: the exact statements and binds each item makes ------------------------------------------------------------------
const recordFile = cacheFile(`record-${variantHash(mantle)}.json`);
const names = items.map((i) => i.name);
const recorded = await runChild({ ...common, mode: "record", recordFile, only: names });
if (!recorded.ok) die(`record failed: ${recorded.error}`);
const recordByName = new Map(decodeJson(readFileSync(recordFile, "utf8")).map((r) => [r.item, r]));
const results = new Map(items.map((item) => {
  const r = recordByName.get(item.name);
  return [item.name, { variant: mantle.label, dialect: "sqlite", item: item.name, kind: item.kind, ...(r.error ? { error: r.error } : { rows: r.rows, statements: r.calls.reduce((n, c) => n + c.stmts.length, 0), parity: { record: r.calls.map((c) => c.counts) } }) }];
}));
const live = () => items.filter((i) => !results.get(i.name).error);
const fail = (name, error) => { Object.assign(results.get(name), { error }); log(`${name} failed: ${error.split("\n")[0]}`); };
for (const r of results.values()) if (r.error) log(`${r.item} failed in record: ${r.error.split("\n")[0]}`);

// ---- cold: fresh processes, items shuffled per sample, sides alternating ----------------------------------------------------
if (wantCold) {
  const per = (item) => (opt["cold-samples"] ? settings.coldSamples : Math.min(item.coldSamples ?? settings.coldSamples, settings.coldSamples));
  const samples = new Map(live().map((i) => [i.name, { mantle: [], native: [] }]));
  const rounds = Math.max(...live().map((i) => per(i) + 1), 0);
  for (let s = 0; s < rounds; s++) {
    log(`cold sample ${s + 1}/${rounds}${s === 0 ? " (discarded)" : ""}`);
    for (const item of shuffle(live().filter((i) => s < per(i) + 1), s)) {
      for (const side of s % 2 ? ["native", "mantle"] : ["mantle", "native"]) {
        const got = await runChild({ ...common, mode: side === "mantle" ? "cold-mantle" : "cold-native", item: item.name, recordFile });
        if (!got.ok) { fail(item.name, got.error); break; }
        if (s > 0) samples.get(item.name)[side].push(got);
      }
    }
  }
  for (const item of live()) {
    const got = samples.get(item.name);
    const r = results.get(item.name);
    r.cold = aggregateCold(got.mantle, got.native);
    r.rows = r.rows ?? got.mantle[0].rows;
    r.parity.native = got.native[0].counts;
    r.parity.mantle = got.mantle[0].counts;
  }
}

// ---- counters: precise coverage, one process per item ---------------------------------------------------------------------------
if (settings.counters) {
  for (const item of live()) {
    const got = await runChild({ ...common, mode: "counters", item: item.name, recordFile });
    if (!got.ok) { fail(item.name, got.error); continue; }
    results.get(item.name).counters = { ...got.counts, status: got.status };
  }
}

// ---- warm: one process, one runtime, paired Mantle/native samples ----------------------------------------------------------------
if (wantWarm) {
  log("warm run");
  const got = await runChild({ ...common, mode: "warm", only: live().map((i) => i.name), ...settings }, 30 * 60_000);
  if (!got.ok) die(`warm failed: ${got.error}`);
  for (const item of live()) {
    const w = got.results[item.name];
    if (w.error) fail(item.name, w.error);
    else results.get(item.name).warm = aggregateWarm(w.rounds);
  }
}

// ---- report -------------------------------------------------------------------------------------------------------------------
const resultList = [...results.values()];
const checks = evaluate({ results: resultList, items, thresholds: app.config.thresholds, strictTiming: opt["strict-timing"] });
const doc = {
  schema: SCHEMA,
  env: { node: process.version, platform: `${platform()} ${process.arch}`, cpu: cpus()[0]?.model ?? "unknown", cpus: cpus().length, date: new Date().toISOString() },
  config: { mode, app: app.config.name, rows: app.config.describe ? Object.entries(app.config.describe()).map(([k, v]) => `${v.toLocaleString("en-US")} ${k}`).join(", ") : undefined, ...settings },
  variants: [{ label: mantle.label, version: mantle.version, sha: mantle.sha }],
  results: resultList.map(({ parity, ...r }) => r),
  checks,
};
const markdown = renderMarkdown(doc);
console.log(markdown);
const jsonPath = resolve(opt.json ?? join(BENCH_DIR, "results", `${doc.env.date.replace(/[:.]/g, "-")}-${mantle.label.replace(/[^\w.@-]/g, "_")}.json`));
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(doc, null, 1)}\n`);
if (opt.out) writeFileSync(resolve(opt.out), markdown);
log(`wrote ${jsonPath}`);

for (const c of checks.filter((c) => !c.ok)) if (process.env.GITHUB_ACTIONS) console.log(`::${c.level === "fail" ? "error" : "warning"}::${c.item} ${c.rule}: ${c.detail}`);
const bad = failures(checks);
if (bad.length) { console.error(`[bench] ${bad.length} failing check(s): ${bad.map((c) => `${c.item} ${c.rule}`).join(", ")}`); process.exit(1); }
