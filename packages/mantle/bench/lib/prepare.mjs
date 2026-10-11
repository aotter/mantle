// Preparation: plans through the real `mantle generate` CLI, and seeded SQLite files cached in the OS temp dir (see CACHE_DIR).
// Never imports Mantle: the seed child (child.mjs --mode seed) is the only process that boots it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Outside the repository: the scratch projects carry a package.json, which scripts/check-boundaries.mjs would scan
export const CACHE_DIR = process.env.MANTLE_BENCH_CACHE ?? join(tmpdir(), "mantle-bench-cache");
const hash = (...parts) => createHash("sha1").update(parts.join("\0")).digest("hex");

/** Where a variant's cache entries live: its dir, version and the build time of its dist. */
export const variantHash = (mantle) => hash(mantle.dir, mantle.version, String(mantle.distMtime)).slice(0, 10);

const quote = (id) => `"${id.replace(/"/g, '""')}"`;

/**
 * Runs the real `mantle generate` for the fixture's manifests in a scratch project whose node_modules/@aotter/mantle is
 * a symlink to the benchmarked package, as scripts/check-doc-examples.mjs does. A `warning:` on stderr is a failure.
 * Because the real generator runs, whatever it lowers at generate time is measured automatically.
 */
export function generatePlan(mantle, manifestsDir, dialect = "sqlite") {
  const project = join(CACHE_DIR, `project-${variantHash(mantle)}-${dialect}`);
  rmSync(project, { recursive: true, force: true });
  mkdirSync(join(project, "node_modules/@aotter"), { recursive: true });
  symlinkSync(mantle.dir, join(project, "node_modules/@aotter/mantle"), "dir");
  writeFileSync(join(project, "package.json"), '{ "type": "module" }\n');
  cpSync(manifestsDir, join(project, "manifests"), { recursive: true });
  const run = spawnSync(process.execPath, [mantle.bin, "generate", "--identity", "none", "--features", "web", "--host", "none", "--dialect", dialect], { cwd: project, encoding: "utf8" });
  if (run.status !== 0 || /^warning:/m.test(run.stdout + run.stderr)) throw new Error(`mantle generate failed in ${project}\n${run.stdout}${run.stderr}`);
  return join(project, ".mantle/generated/plan.json");
}

/** `plan.json` is either `{ sourceHash, plan }` (what generate writes) or a bare plan. */
export const readPlan = (path) => {
  const json = JSON.parse(readFileSync(path, "utf8"));
  return json.plan ?? json;
};

export const planFingerprint12 = (planPath) => readPlan(planPath).fingerprint.slice(0, 12);

/**
 * Multi-row INSERTs of declared-name row objects through `driver.batch`, in chunks of 200 rows.
 * Physical columns are id, created_at, updated_at, the scope column, then each declared field's physical name (the key of
 * `plan.schemas[s].fields`, `names` being the inverse map); values go through the dialect codec. version defaults to 1.
 */
export async function insertRows(driver, plan, codec, rows, { chunk = 200, perBatch = 25, nowIso = "1970-01-01T00:00:00Z" } = {}) {
  const statements = Object.entries(rows).flatMap(([schemaName, list]) => {
    const schema = plan.schemas[schemaName];
    if (!schema) throw new Error(`the plan has no Schema '${schemaName}'`);
    const fieldKeys = Object.keys(schema.fields).filter((k) => k !== schema.scope);
    const columns = ["id", "created_at", "updated_at", ...(schema.scope ? [schema.scope] : []), ...fieldKeys];
    const types = ["text", "timestamptz", "timestamptz", ...(schema.scope ? [schema.fields[schema.scope]] : []), ...fieldKeys.map((k) => schema.fields[k])];
    const names = [null, null, null, ...(schema.scope ? [schema.names[schema.scope]] : []), ...fieldKeys.map((k) => schema.names[k])];
    const encodeRow = (row) => columns.map((_, i) => (i === 0 ? row.id : i < 3 ? codec.encode("timestamptz", nowIso) : codec.encode(types[i], row[names[i]])));
    return Array.from({ length: Math.ceil(list.length / chunk) }, (_, c) => {
      const part = list.slice(c * chunk, (c + 1) * chunk);
      const binds = part.flatMap(encodeRow);
      const values = part.map((_, r) => `(${columns.map((__, i) => `?${r * columns.length + i + 1}`).join(",")})`).join(",");
      return { sql: `INSERT INTO ${quote(schemaName)} (${columns.map(quote).join(",")}) VALUES ${values}`, binds };
    });
  });
  for (let i = 0; i < statements.length; i += perBatch) await driver.batch(statements.slice(i, i + perBatch));
}

/** The files a variant needs: the plan (generated or the app's own) and a seeded SQLite file. */
export function prepareFiles({ mantle, target, seedReset, seedVersion }) {
  const { config, dir } = target;
  mkdirSync(CACHE_DIR, { recursive: true });
  const planPath = config.manifests ? generatePlan(mantle, resolve(dir, config.manifests)) : resolve(dir, config.plan);
  if (!existsSync(planPath)) throw new Error(`no plan at ${planPath}`);
  const fp = planFingerprint12(planPath);
  if (config.sqlite) {
    // an app's own snapshot is copied once per variant and never written back
    const source = resolve(dir, config.sqlite);
    const st = statSync(source);
    const dbPath = join(CACHE_DIR, `db-${variantHash(mantle)}-${hash(source, String(st.mtimeMs), String(st.size)).slice(0, 10)}.sqlite`);
    if (seedReset || !existsSync(dbPath)) copyFileSync(source, dbPath);
    return { planPath, dbPath, needsSeed: false };
  }
  const dbPath = join(CACHE_DIR, `db-${variantHash(mantle)}-${fp}-seed${seedVersion}.sqlite`);
  if (seedReset) rmSync(dbPath, { force: true });
  return { planPath, dbPath, needsSeed: !existsSync(dbPath) };
}

export const cacheFile = (name) => (mkdirSync(CACHE_DIR, { recursive: true }), join(CACHE_DIR, name));
