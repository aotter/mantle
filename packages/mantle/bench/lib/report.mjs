// Markdown and JSON rendering, and the compare of two saved result files. Pure functions over the result document.


export const SCHEMA = "mantle-bench/1";
const COUNTER_ORDER = ["compile", "check", "policy", "paged", "print", "zod", "storeIr"];
const f0 = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "n/a");
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "n/a");
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
const counts = (c) => (c ? COUNTER_ORDER.map((k) => c[k]).join("/") : "n/a");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map((_, i) => (i < 2 ? "---" : "---:")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

export function renderMarkdown(doc) {
  const { env, config } = doc;
  const lines = [
    `# Runtime overhang: ${doc.variants.map((v) => v.label).join(" vs ")}`,
    "",
    "Local Node measurements over node:sqlite. Not a Cloudflare, D1 or production claim (see bench/README.md).",
    "",
    table(["field", "value"], [
      ["variant", doc.variants.map((v) => `${v.label} (@aotter/mantle ${v.version}, git ${v.sha})`).join("; ")],
      ["app", `${config.app} (${config.rows ?? "no row summary"})`],
      ["dialect", "sqlite via node:sqlite (a local file database; reads are nearly free compared with D1 over RPC)"],
      ["node", `${env.node} on ${env.platform}`],
      ["cpu", `${env.cpu} x${env.cpus}`],
      ["mode", `${config.mode}; warm: ${config.rounds} rounds x up to ${config.samples} samples (warmup ${config.warmup}, ${config.budgetMs} ms budget per item per round); cold: ${config.coldSamples} fresh processes per item per side (+1 discarded); counters ${config.counters ? "on" : "off"}`],
      ["date", env.date],
    ]),
    "",
  ];
  const results = doc.results.filter((r) => !r.error);
  const warm = results.filter((r) => r.warm);
  if (warm.length) {
    lines.push("## Warm", "", "Overhang is the median over sample pairs of (Mantle wall - native replay of the exact SQL and binds Mantle sent). Counters are compile/check/policy/paged/print/zod/storeIr per warm call.", "",
      table(["item", "kind", "n", "stmts", "native p50 µs", "mantle p50 µs", "overhang p50 µs", "ratio", "mantle p95 µs", "mantle CPU p50 µs", "cpu/call µs m/n", "warm counters"],
        warm.map((r) => {
          const w = r.warm.summary;
          return [r.item, r.kind, w.n, r.statements ?? "n/a", f0(w.nativeP50), f0(w.mantleP50), f0(w.overhangP50), f1(w.ratio), f0(w.mantleP95), f0(w.mantleCpuP50), `${f0(w.cpuPerCallUs.mantle)}/${f0(w.cpuPerCallUs.native)}`, counts(r.counters?.warm)];
        })), "");
  }
  const cold = results.filter((r) => r.cold);
  if (cold.length) {
    lines.push("## Cold", "", "Each sample is a fresh Node process on an already converged database. Cold overhang = Mantle first call - native first call; imports, plan parse and boot are reported separately.", "",
      table(["item", "n", "import core+dialect ms", "plan ms", "boot ms", "first ms", "first SQL ms", "first Mantle CPU ms", "native first ms", "cold overhang ms", "2nd ms", "first-call counters"],
        cold.map((r) => {
          const c = r.cold;
          return [r.item, c.mantle.first.n, f1(c.mantle.importCore.p50 + c.mantle.importDialect.p50), f1(c.mantle.plan.p50), f1(c.mantle.boot.p50), f1(c.mantle.first.p50), f1(c.mantle.firstSql.p50), f1(c.firstMantleCpu), f2(c.native.first.p50), f1(c.overhang), f1(c.mantle.second.p50), counts(r.counters?.first)];
        })), "");
  }
  const counters = results.filter((r) => r.counters);
  if (counters.length) {
    lines.push("## Counters by phase", "", "compile/check/policy/paged/print/zod/storeIr, from V8 precise coverage in separate processes.", "",
      table(["item", "boot", "first call", "second call", "warm call"], counters.map((r) => [r.item, counts(r.counters.boot), counts(r.counters.first), counts(r.counters.second), counts(r.counters.warm)])), "");
  }
  if (doc.results.some((r) => r.error)) lines.push("## Failed items", "", ...doc.results.filter((r) => r.error).map((r) => `- ${r.item}: ${r.error.split("\n")[0]}`), "");
  if (doc.checks?.length) {
    const bad = doc.checks.filter((c) => !c.ok);
    lines.push("## Checks", "", bad.length ? bad.map((c) => `- ${c.level.toUpperCase()} ${c.item} ${c.rule}: ${c.detail}`).join("\n") : `All ${doc.checks.length} checks passed.`, "");
  }
  return lines.join("\n");
}

const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && a !== 0 ? `${(((b - a) / a) * 100).toFixed(0)}%` : "n/a");
const delta = (a, b, f) => `${f(a)} -> ${f(b)} (${pct(a, b)})`;

/** Joins two saved result documents on (dialect, item) and prints p50 deltas and counters side by side. */
export function compare(base, head) {
  const key = (r) => `${r.dialect}|${r.item}`;
  const baseBy = new Map(base.results.map((r) => [key(r), r]));
  const rows = head.results.filter((r) => baseBy.has(key(r))).map((h) => {
    const b = baseBy.get(key(h));
    return [h.item, b.warm && h.warm ? delta(b.warm.summary.mantleP50, h.warm.summary.mantleP50, f0) : "n/a", b.warm && h.warm ? delta(b.warm.summary.overhangP50, h.warm.summary.overhangP50, f0) : "n/a",
      b.cold && h.cold ? delta(b.cold.mantle.first.p50, h.cold.mantle.first.p50, f1) : "n/a", b.cold && h.cold ? delta(b.cold.overhang, h.cold.overhang, f1) : "n/a",
      `${counts(b.counters?.first)} -> ${counts(h.counters?.first)}`, `${counts(b.counters?.warm)} -> ${counts(h.counters?.warm)}`];
  });
  const label = (d) => d.variants.map((v) => v.label).join("+");
  return [
    `# Runtime overhang: ${label(base)} -> ${label(head)}`, "",
    "p50 values, base -> head (relative change). Counters are compile/check/policy/paged/print/zod/storeIr. Both files must come from the same machine and settings to mean anything.", "",
    table(["item", "warm mantle µs", "warm overhang µs", "cold first ms", "cold overhang ms", "first-call counters", "warm counters"], rows), "",
    ...(head.results.length !== rows.length ? [`${head.results.length - rows.length} head item(s) have no match in the base file.`, ""] : []),
  ].join("\n");
}


