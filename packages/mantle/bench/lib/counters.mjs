// Exact call counts of the runtime's expensive steps, from V8 precise coverage (node:inspector).
// Production code is never instrumented. Coverage distorts timing, so counters are only ever collected in
// their own child processes (child.mjs --mode counters), never in a timing run.
//
// THIS TABLE IS THE ONE PLACE to update when a change renames or moves one of these functions: a rename shows up
// as status "missing" (the file is loaded, the function is not in it) instead of a silent zero.
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { fileURLToPath } from "node:url";

/** Package-relative file suffixes; a function counts only when its script lives under the Mantle package dir. */
export const TARGETS = [
  { key: "compile", fn: "compileProgram", files: ["dist/core/sql/compile.js"], what: "SQL IR to executable program (cache miss)" },
  // the d1 validator delegates to core/sql/allowlist.js validateIr: only the dialect file counts, or each check would count twice
  { key: "check", fn: "validateIr", files: ["dist/d1/validator.js", "dist/postgres/validator.js"], what: "dialect allowlist check" },
  { key: "policy", fn: "applyPolicy", files: ["dist/core/sql/policy.js"], what: "scope/TTL/publish policy rewrite" },
  { key: "paged", fn: "pagedOf", files: ["dist/core/sql/run.js"], what: "paged form of a View (cache miss)" },
  { key: "print", fn: "print", files: ["dist/d1/print.js", "dist/postgres/print.js"], what: "IR to SQL text" },
  { key: "zod", fn: "jsonSchemaToZod", files: ["dist/spec/domain/service/JsonSchemaToZod.js"], what: "JSON Schema to zod validator" },
  { key: "storeIr", fn: "select", files: ["dist/core/store/json.js"], what: "StoreJson.select builds fresh IR (matched by file: run.js has other `select`s)" },
  { key: "deparse", fn: "deparse", anyUrl: "/pgsql-deparser/", info: true, what: "pgsql-deparser calls (informational)" },
];

export const KEYS = TARGETS.map((t) => t.key);
export const GATED_KEYS = TARGETS.filter((t) => !t.info).map((t) => t.key);

/** `file:///x/packages/mantle/` with a trailing slash. */
export const rootUrl = (mantleDirUrl) => (mantleDirUrl.endsWith("/") ? mantleDirUrl : `${mantleDirUrl}/`);

/**
 * Pure mapping of a `Profiler.takePreciseCoverage` result onto the target table.
 * `state.seen` (url -> Set of function names) accumulates across takes, because a take only reports what changed:
 *   ok         at least one matching function exists in a loaded script
 *   not-loaded no script of the target's file(s) was ever loaded (counts as 0)
 *   missing    the file is loaded but has no function of that name (renamed or removed)
 * V8 reports only functions it has compiled, so a function never called may be absent from the coverage: before calling it
 * missing, `sourceOf(url)` (the script's text) must also fail to define it. Without `sourceOf`, absence alone is "missing".
 */
export function mapCoverage(scripts, mantleDirUrl, state = { seen: new Map() }, sourceOf = undefined) {
  const root = rootUrl(mantleDirUrl);
  for (const script of scripts) {
    const names = state.seen.get(script.url) ?? new Set();
    for (const f of script.functions) names.add(f.functionName);
    state.seen.set(script.url, names);
  }
  const counts = {};
  const status = {};
  for (const t of TARGETS) {
    const match = (url) => (t.anyUrl ? url.includes(t.anyUrl) : url.startsWith(root) && t.files.some((f) => url === `${root}${f}`));
    const loaded = [...state.seen.keys()].filter(match);
    counts[t.key] = scripts
      .filter((s) => match(s.url))
      .flatMap((s) => s.functions.filter((f) => f.functionName === t.fn))
      .reduce((sum, f) => sum + (f.ranges[0]?.count ?? 0), 0);
    const defined = (url) => {
      if (state.seen.get(url).has(t.fn)) return true;
      const text = sourceOf?.(url);
      return text !== undefined && new RegExp(`function\\s+${t.fn}\\s*\\(|^\\s*(async\\s+)?${t.fn}\\s*\\([^)]*\\)\\s*\\{`, "m").test(text);
    };
    status[t.key] = !loaded.length ? "not-loaded" : loaded.some(defined) ? "ok" : "missing";
  }
  return { counts, status };
}

/** A live coverage session. Start it BEFORE importing Mantle; `take()` returns the counts since the previous take. */
export async function startCoverage(mantleDirUrl) {
  const session = new Session();
  session.connect();
  // a script loaded before coverage starts would be invisible to it: refuse instead of reporting zeros
  const early = [];
  const root = rootUrl(mantleDirUrl);
  session.on("Debugger.scriptParsed", (m) => { if (m.params.url.startsWith(`${root}dist/`)) early.push(m.params.url); });
  await session.post("Debugger.enable");
  await session.post("Debugger.disable");
  if (early.length) throw new Error(`coverage must start before Mantle is imported; already loaded: ${early[0]}`);
  await session.post("Profiler.enable");
  await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  const state = { seen: new Map() };
  const sourceOf = (url) => { try { return readFileSync(fileURLToPath(url), "utf8"); } catch { return undefined; } };
  return {
    async take() {
      const { result } = await session.post("Profiler.takePreciseCoverage");
      return mapCoverage(result, mantleDirUrl, state, sourceOf);
    },
    async stop() {
      await session.post("Profiler.stopPreciseCoverage");
      session.disconnect();
    },
  };
}
