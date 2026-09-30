/**
 * `mantle generate` and `mantle generate --check` (ADR-0032 decision 12 and amendment "mantle generate"): manifests and
 * `mantle.config.json` in, `.mantle/generated/plan.json` and `.mantle/generated/mantle.ts` out. It never installs a package.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process, { cwd as processCwd, stderr, stdout } from "node:process";
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
  mcp: ["@modelcontextprotocol/server", "@modelcontextprotocol/ext-apps"], admin: ["@aotter/mantle-ui"], web: [],
  mantle: ["better-auth", "@better-auth/oauth-provider", "@better-auth/mcp", "@better-auth/cimd"], custom: [], none: [],
};

export interface GenerateDeps {
  readonly cwd?: string;
  /** The database the `--check` storage dry-run reads; the bin opens `--database <file>` instead. */
  readonly driver?: DatabaseDriver;
}

/** compilePlan's key order is already deterministic, and a JSON Schema's `properties` order is what Admin and MCP show. */
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
/** A BOM or CRLF line endings (a Windows checkout) are not a different source. */
const normalize = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
const readText = (path: string) => readFile(path, "utf8").then(normalize, () => undefined);

function findUp(root: string, rel: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, rel))) return join(dir, rel);
    if (dirname(dir) === dir) return undefined;
  }
}

const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"];

/** The nearest directory with a lockfile decides the package manager. */
function installCommand(root: string, packages: readonly string[]): string {
  let lock: string | undefined;
  for (let dir = root; !lock; dir = dirname(dir)) {
    lock = LOCKFILES.find((f) => existsSync(join(dir, f)));
    if (dirname(dir) === dir) break;
  }
  const add = lock === "pnpm-lock.yaml" ? "pnpm add" : lock === "yarn.lock" ? "yarn add" : lock?.startsWith("bun") ? "bun add" : "npm install";
  return `${add} ${packages.join(" ")}`;
}

/**
 * A `node_modules` walk, the layout bundlers resolve from. Under Yarn PnP there is no `node_modules`, so Node's own resolution
 * decides; elsewhere it is not used, because it also honours `NODE_PATH`, which a bundler does not.
 */
function installed(root: string, name: string): boolean {
  if (!process.versions.pnp) return !!findUp(root, join("node_modules", name, "package.json"));
  try {
    createRequire(join(root, "package.json")).resolve(`${name}/package.json`);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED"; // found, it just does not export package.json
  }
}

/** Each selected feature (and the identity) whose packages are not installed, and `admin` without an identity. */
function featureDiagnostics(root: string, config: MantleConfig): Diagnostic[] {
  const out: Diagnostic[] = [];
  const need = (what: string, packages: readonly string[]) => {
    const missing = packages.filter((p) => !installed(root, p));
    if (missing.length)
      out.push(validateDiagnostic({ code: "GENERATE_FEATURE_DEPENDENCY_MISSING", severity: "error", path: what, message: `${what} needs ${missing.join(", ")}, which ${missing.length > 1 ? "are" : "is"} not installed. Run \`${installCommand(root, missing)}\`; mantle generate never installs packages.` }));
  };
  need("@aotter/mantle", ["@aotter/mantle"]);
  need(`identity '${config.identity}'`, PACKAGES[config.identity]);
  for (const f of config.features) need(`feature '${f}'`, PACKAGES[f]);
  if (config.features.includes("admin") && config.identity === "none")
    out.push(validateDiagnostic({ code: "GENERATE_FEATURE_DEPENDENCY_MISSING", severity: "error", path: "feature 'admin'", message: "feature 'admin' needs a caller identity, and identity is 'none'. Pass --identity mantle or --identity custom, or leave admin out of --features." }));
  return out;
}

function readConfig(text: string): { config: MantleConfig; raw: Record<string, unknown> } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${CONFIG} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${CONFIG} must be a JSON object.`);
  if (v.version === 1 || "host" in v) throw new Error(`${CONFIG} is a 0.1.x selection (version 1, with a host): run mantle-update to move it to version 2.`);
  const features = v.features as Feature[];
  if (v.version !== 2 || !IDENTITIES.includes(v.identity as Identity) || !Array.isArray(features) || FEATURES.filter((f) => features.includes(f)).join() !== features.join())
    throw new Error(`${CONFIG} must be { "version": 2, "identity": ${IDENTITIES.map((i) => `"${i}"`).join(" | ")}, "features": a subset of ${FEATURES.join(", ")} in that order }.`);
  return { config: { version: 2, identity: v.identity as Identity, features }, raw: v };
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
  const names = (await readdir(dir, { withFileTypes: true })).filter((d) => !d.isDirectory() && /\.ya?ml$/i.test(d.name)).map((d) => d.name).sort();
  return Promise.all(names.map(async (name) => ({ name, text: normalize(await readFile(join(dir, name), "utf8")) })));
}

/** `node:sqlite` on Node 22 binds only anonymous `?`, so a numbered `?N` becomes `?` with its value in the order it appears. */
async function openSqliteFile(path: string): Promise<DatabaseDriver> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    batch: async (stmts) => stmts.map((s) => {
      const binds: unknown[] = [];
      const sql = s.sql.replace(/\?(\d+)/g, (_, n: string) => (binds.push(s.binds![Number(n) - 1]), "?"));
      return { rows: db.prepare(sql).all(...(binds as never[])) as Record<string, unknown>[] };
    }),
  };
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
  let saved: ReturnType<typeof readConfig> | undefined;
  try {
    const savedText = await readFile(join(root, CONFIG), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
    saved = savedText === undefined ? undefined : readConfig(savedText);
    config = select(saved?.config, values.features, values.identity);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const manifests = values.manifests ?? "manifests";
  let files: { name: string; text: string }[];
  try {
    files = await readManifests(resolve(root, manifests));
  } catch (err) {
    return (stderr.write(`MANIFEST_ROOT_NOT_FOUND ${manifests}: cannot read the manifest directory (${(err as NodeJS.ErrnoException).code ?? "error"})\n`), 1);
  }
  if (!files.length) return (stderr.write(`MANIFEST_ROOT_NOT_FOUND ${manifests}: no .yaml or .yml manifest files\n`), 1);
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
  ];
  // the config is rewritten only when the selection changes, and keeps whatever else it holds
  if (!saved || saved.config.identity !== config.identity || saved.config.features.join() !== config.features.join())
    outputs.push([CONFIG, json({ ...saved?.raw, version: 2, identity: config.identity, features: config.features })]);

  if (!check) {
    for (const d of [".mantle", OUT]) {
      const st = await lstat(join(root, d)).catch(() => undefined);
      if (st?.isSymbolicLink()) return (stderr.write(`Refusing to write through the symlink ${d}; generated files live in a real directory.\n`), 2);
    }
    for (const [path, text] of outputs) {
      if ((await readText(join(root, path))) === text) continue;
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text, "utf8");
    }
    stdout.write(`Generated ${OUT}/plan.json and ${OUT}/mantle.ts (fingerprint ${compiled.plan.fingerprint.slice(0, 12)}; identity ${config.identity}; features ${config.features.join(", ") || "none"}).\n`);
    return 0;
  }

  let code = 0;
  for (const [path, text] of outputs) {
    if ((await readText(join(root, path))) === text) continue;
    stderr.write(`stale: ${path}\n`);
    code = 1;
  }
  if (code) stderr.write("Mantle generated files are stale; run `mantle generate`.\n");

  if (!deps.driver && values.database === undefined) return code;
  try {
    const storage = await planStorageChanges(deps.driver ?? (await openSqliteFile(resolve(root, values.database!))), compiled.plan.schemas, { fingerprint: compiled.plan.fingerprint });
    for (const u of storage.undeclared) stdout.write(`-- ${u.code} ${u.schema}: ${u.message}\n`);
    if (storage.skipped) stdout.write("-- Storage: this database already booted this plan's fingerprint; boot applies nothing.\n");
    else if (storage.blocked.length) {
      for (const b of storage.blocked) stderr.write(`${b.code} ${b.schema}: ${b.message}\n`);
      stderr.write("Storage convergence is blocked: boot refuses to serve until the changes above are made.\n");
      code = 1;
    } else if (!storage.sql.length) stdout.write("-- Storage: nothing to do.\n");
    else stdout.write(`-- The SQL storage convergence would run on this database (nothing was applied):\n${storage.sql.map((q) => `${q};\n`).join("")}`);
  } catch (err) {
    // a missing, corrupt, locked or non-file database: say which, without a stack or the absolute path
    return (stderr.write(`--database ${values.database}: ${(err instanceof Error ? err.message : String(err)).replaceAll(root, ".")}\n`), 2);
  }
  return code;
}
