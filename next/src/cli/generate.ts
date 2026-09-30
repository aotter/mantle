/**
 * `mantle generate` and `mantle generate --check` (ADR-0032 decision 12 and amendment "mantle generate"): manifests and
 * `mantle.config.json` in, `.mantle/generated/plan.json` and `.mantle/generated/mantle.ts` out. It never installs a package.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cwd as processCwd, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";
import type { DatabaseDriver } from "../core/driver.js";
import { planStorageChanges } from "../core/sql/storage.js";
import { compileLinkedPlan, parseManifestSources, validateDiagnostic, ValidateManifestsUseCase, type Diagnostic } from "../spec/index.js";
import { translateParseArgsError } from "../spec/infrastructure/cli/parseArgsError.js";
import { emitMantleModule } from "./emitModule.js";

const FEATURES = ["mcp", "admin", "web"] as const;
const IDENTITIES = ["mantle", "custom", "none"] as const;
type Feature = (typeof FEATURES)[number];
type Identity = (typeof IDENTITIES)[number];
/** `mantle.config.json` v2: no `host`, and features no longer close over their dependencies. */
interface MantleConfig {
  readonly version: 2;
  readonly identity: Identity;
  readonly features: readonly Feature[];
}

const CONFIG = "mantle.config.json";
const OUT = ".mantle/generated";
/** The packages a selection needs in the project; `@aotter/mantle` itself is always one. */
const PACKAGES: Readonly<Record<Feature | Identity, readonly string[]>> = {
  mcp: ["@modelcontextprotocol/server"], admin: ["@aotter/mantle-ui"], web: [], mantle: ["better-auth"], custom: [], none: [],
};

export interface GenerateDeps {
  readonly cwd?: string;
  /** The database the `--check` storage dry-run reads; the bin opens `--database <file>` instead. */
  readonly driver?: DatabaseDriver;
}

/** Object keys sorted, arrays in order: identical input gives identical bytes. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
}
const json = (v: unknown) => `${JSON.stringify(sorted(v), null, 2)}\n`;

function findUp(root: string, rel: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, rel))) return join(dir, rel);
    if (dirname(dir) === dir) return undefined;
  }
}

function installCommand(root: string, packages: readonly string[]): string {
  const lock = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"].find((f) => findUp(root, f));
  const add = lock === "pnpm-lock.yaml" ? "pnpm add" : lock === "yarn.lock" ? "yarn add" : lock?.startsWith("bun") ? "bun add" : "npm install";
  return `${add} ${packages.join(" ")}`;
}

/** Each selected feature (and the identity) whose packages are not installed, and `admin` without an identity. */
function featureDiagnostics(root: string, config: MantleConfig): Diagnostic[] {
  const out: Diagnostic[] = [];
  const need = (what: string, packages: readonly string[]) => {
    const missing = packages.filter((p) => !findUp(root, join("node_modules", p, "package.json")));
    if (missing.length)
      out.push(validateDiagnostic({ code: "GENERATE_FEATURE_DEPENDENCY_MISSING", severity: "error", path: what, message: `${what} needs ${missing.join(", ")}, which is not installed. Run \`${installCommand(root, missing)}\`; mantle generate never installs packages.` }));
  };
  need("@aotter/mantle", ["@aotter/mantle"]);
  need(`identity '${config.identity}'`, PACKAGES[config.identity]);
  for (const f of config.features) need(`feature '${f}'`, PACKAGES[f]);
  if (config.features.includes("admin") && config.identity === "none")
    out.push(validateDiagnostic({ code: "GENERATE_FEATURE_DEPENDENCY_MISSING", severity: "error", path: "feature 'admin'", message: "feature 'admin' needs a caller identity, and identity is 'none'. Pass --identity mantle or --identity custom, or leave admin out of --features." }));
  return out;
}

function readConfig(text: string): MantleConfig {
  const v = JSON.parse(text) as Record<string, unknown>;
  if (v.version === 1 || "host" in v) throw new Error(`${CONFIG} is a 0.1.x selection (version 1, with a host): run mantle-update to move it to version 2.`);
  const features = v.features as Feature[];
  if (v.version !== 2 || !IDENTITIES.includes(v.identity as Identity) || !Array.isArray(features) || FEATURES.filter((f) => features.includes(f)).join() !== features.join())
    throw new Error(`${CONFIG} must be { "version": 2, "identity": ${IDENTITIES.map((i) => `"${i}"`).join(" | ")}, "features": a subset of ${FEATURES.join(", ")} in that order }.`);
  return { version: 2, identity: v.identity as Identity, features };
}

/** The selection: saved config, then flags. An explicit `--features` without `--identity` means `none` (decision 12). */
function select(saved: MantleConfig | undefined, features: string | undefined, identity: string | undefined): MantleConfig {
  if (identity !== undefined && !IDENTITIES.includes(identity as Identity)) throw new Error(`--identity must be one of ${IDENTITIES.join(", ")}; got ${identity}`);
  if (saved && identity !== undefined && identity !== saved.identity)
    throw new Error(`Switching identity from '${saved.identity}' to '${identity}' on a rerun is refused: it never drops tables. Change ${CONFIG} deliberately once the data is moved.`);
  const picked = features === undefined ? saved?.features ?? FEATURES : features.split(",").map((f) => f.trim()).filter(Boolean);
  const unknown = picked.filter((f) => !FEATURES.includes(f as Feature));
  if (unknown.length) throw new Error(`--features accepts only ${FEATURES.join(", ")}; got ${unknown.join(", ")}`);
  return { version: 2, identity: (identity ?? saved?.identity ?? (features === undefined ? "mantle" : "none")) as Identity, features: FEATURES.filter((f) => picked.includes(f)) };
}

/** Every `.yaml`/`.yml` file directly in the manifest directory, by name. */
async function readManifests(dir: string): Promise<{ name: string; text: string }[]> {
  const names = (await readdir(dir)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(dir, name), "utf8") })));
}

async function openSqliteFile(path: string): Promise<DatabaseDriver> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  return { batch: async (stmts) => stmts.map((s) => ({ rows: db.prepare(s.sql).all(...((s.binds ?? []) as never[])) as Record<string, unknown>[] })) };
}

const print = (ds: readonly Diagnostic[]) => ds.forEach((d) => stderr.write(`${d.code} ${d.path}: ${d.message}\n`));

const HELP = `mantle generate — compile manifests to .mantle/generated/plan.json and mantle.ts

Usage: mantle generate [options]

Options:
  --manifests <dir>    Manifest directory (default: ./manifests)
  --features <list>    Comma-separated positive list of ${FEATURES.join(", ")} (default: all)
  --identity <kind>    ${IDENTITIES.join(", ")} (default: mantle; none with an explicit --features)
  --check              Write nothing; exit 1 when a generated file or ${CONFIG} is stale
  --database <file>    With --check: a SQLite file (e.g. wrangler's local D1 under .wrangler/state/v3/d1/),
                       opened read-only; prints the SQL storage convergence would run
  -h, --help           This help
`;

export async function runGenerate(rawArgs: readonly string[], deps: GenerateDeps = {}): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: [...rawArgs], options: { manifests: { type: "string" }, features: { type: "string" }, identity: { type: "string" }, check: { type: "boolean" }, database: { type: "string" }, help: { type: "boolean", short: "h" } } }));
  } catch (err) {
    stderr.write(`${(translateParseArgsError(err) as Error).message}\n`);
    return 2;
  }
  if (values.help) return (stdout.write(HELP), 0);
  const root = resolve(deps.cwd ?? processCwd());
  const check = values.check === true;
  if (values.database !== undefined && !check) return (stderr.write("--database is read only with --check.\n"), 2);

  let config: MantleConfig;
  let savedText: string | undefined;
  try {
    savedText = await readFile(join(root, CONFIG), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
    config = select(savedText === undefined ? undefined : readConfig(savedText), values.features, values.identity);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const dir = resolve(root, values.manifests ?? "manifests");
  let files: { name: string; text: string }[];
  try {
    files = await readManifests(dir);
  } catch (err) {
    return (stderr.write(`MANIFEST_ROOT_NOT_FOUND ${dir}: ${err instanceof Error ? err.message : String(err)}\n`), 1);
  }
  if (!files.length) return (stderr.write(`MANIFEST_ROOT_NOT_FOUND ${dir}: no .yaml or .yml manifest files\n`), 1);
  const parsed = parseManifestSources({ sources: files.map((f) => ({ sourceId: f.name, text: f.text })) });
  if (!parsed.ok) return (print(parsed.diagnostics), 1);
  const validation = ValidateManifestsUseCase.run({ parsed: parsed.value });
  const errors = validation.diagnostics.filter((d) => d.severity === "error");
  if (errors.length || !validation.linked) return (print(errors), 1);
  const compiled = await compileLinkedPlan(validation.linked);
  if (!compiled.ok) return (print(compiled.diagnostics), 1);

  const missing = featureDiagnostics(root, config);
  if (missing.length) return (print(missing), 1);

  // the source hash is the manifests as authored, keyed by name so the project's location never enters it
  const sourceHash = createHash("sha256").update(JSON.stringify(files.map((f) => [f.name, f.text]))).digest("hex");
  const outputs: [string, string][] = [
    [join(OUT, "plan.json"), json({ sourceHash, plan: compiled.plan })],
    [join(OUT, "mantle.ts"), emitMantleModule(compiled.plan, validation.linked)],
    [CONFIG, json(config)],
  ];

  if (!check) {
    for (const [path, text] of outputs) {
      if ((await readFile(join(root, path), "utf8").catch(() => undefined)) === text) continue;
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text, "utf8");
    }
    stdout.write(`Generated ${OUT}/plan.json and ${OUT}/mantle.ts (fingerprint ${compiled.plan.fingerprint.slice(0, 12)}; identity ${config.identity}; features ${config.features.join(", ") || "none"}).\n`);
    return 0;
  }

  let code = 0;
  for (const [path, text] of outputs) {
    if ((await readFile(join(root, path), "utf8").catch(() => undefined)) === text) continue;
    stderr.write(`stale: ${path}\n`);
    code = 1;
  }
  if (code) stderr.write("Mantle generated files are stale; run `mantle generate`.\n");

  let driver = deps.driver;
  try {
    if (!driver && values.database !== undefined) driver = await openSqliteFile(resolve(root, values.database));
  } catch (err) {
    return (stderr.write(`--database ${values.database}: ${err instanceof Error ? err.message : String(err)}\n`), 2);
  }
  if (driver) {
    const storage = await planStorageChanges(driver, compiled.plan.schemas);
    stdout.write(`-- The SQL storage convergence would run on this database (nothing was applied):\n${storage.sql.map((s) => `${s};\n`).join("")}`);
    for (const u of storage.undeclared) stdout.write(`-- ${u.code} ${u.schema}: ${u.message}\n`);
    for (const b of storage.blocked) stderr.write(`${b.code} ${b.schema}: ${b.message}\n`);
    if (storage.blocked.length) code = 1;
  }
  return code;
}
