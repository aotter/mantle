/**
 * `mantle generate` and `mantle generate --check` (ADR-0032 decision 12 and amendment "mantle generate"): manifests and
 * `mantle.config.json` in, `.mantle/generated/plan.json` and `.mantle/generated/mantle.ts` out. It never installs a package.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process, { cwd as processCwd, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";
import type { DatabaseDriver } from "../core/driver.js";
import { planStorageChanges } from "../d1/storage.js";
import { compileLinkedPlan, parseManifestSources, validateDiagnostic, ValidateManifestsUseCase, type Diagnostic, type SqlDialect } from "../spec/index.js";
import * as d1 from "../d1/compile/index.js";
import * as pg from "../postgres/compile/index.js";
import { translateParseArgsError } from "../spec/infrastructure/cli/parseArgsError.js";
import { emitMantleModule } from "./emitModule.js";
import { toCloudflareCron } from "../spec/domain/service/CloudflareCron.js";
import { presetWarnings, writePreset } from "./preset.js";

const FEATURES = ["mcp", "admin", "web"] as const;
const IDENTITIES = ["mantle", "custom", "none"] as const;
/** Where the service runs (ADR-0036). `none` writes no preset: the application wires `createMantle` itself. */
const HOSTS = ["cloudflare", "none"] as const;
type Feature = (typeof FEATURES)[number];
type Identity = (typeof IDENTITIES)[number];
type Host = (typeof HOSTS)[number];
/** `mantle.config.json` v2: features no longer close over their dependencies; `host` and `dialect` are ADR-0036's two axes. */
interface MantleConfig {
  readonly version: 2;
  readonly identity: Identity;
  readonly features: readonly Feature[];
  /** Absent is `cloudflare`. Never part of the plan. */
  readonly host?: Host;
  /** `sqlite` (alias `d1`), `postgres`, or a dialect package (ADR-0035 decision 5); absent is `sqlite`. */
  readonly dialect?: string;
}
/** The built-in dialects by every name a config may give them. The SQLite dialect's plans still record `@aotter/mantle/d1`. */
const BUILT_IN: Readonly<Record<string, "sqlite" | "postgres">> = { sqlite: "sqlite", d1: "sqlite", [d1.name]: "sqlite", postgres: "postgres", [pg.name]: "postgres" };
const builtInOf = (dialect: string | undefined) => (dialect === undefined ? "sqlite" : BUILT_IN[dialect]);

const CONFIG = "mantle.config.json";
const OUT = ".mantle/generated";
/** The packages a selection needs in the project; `@aotter/mantle` itself is always one. */
const PACKAGES: Readonly<Record<Feature | Identity, readonly string[]>> = {
  mcp: ["@modelcontextprotocol/server", "@modelcontextprotocol/ext-apps"], admin: ["@aotter/mantle-ui"], web: [],
  mantle: ["better-auth", "@better-auth/oauth-provider", "@better-auth/mcp", "@better-auth/cimd"], custom: [], none: [],
};
/** What a Cloudflare preset over PostgreSQL imports (Hyperdrive speaks the PostgreSQL protocol; `pg` is the driver). */
const POSTGRES_PACKAGES = ["pg"];

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
  // a preset written now serves the staff MCP App, which @aotter/mantle-ui builds; a service already written is the application's
  const writesPreset = (config.host ?? "cloudflare") === "cloudflare" && !!builtInOf(config.dialect) && !existsSync(join(root, "src/service.ts"));
  if (writesPreset && builtInOf(config.dialect) === "postgres") need("dialect 'postgres' on Cloudflare", POSTGRES_PACKAGES);
  if (writesPreset && config.features.includes("mcp") && config.identity !== "none" && !config.features.includes("admin")) need("the staff MCP App", ["@aotter/mantle-ui"]);
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
  if (v.version === 1) throw new Error(`${CONFIG} is a 0.1.x selection (version 1, with a host): move it to version 2 as node_modules/@aotter/mantle/docs/upgrade-0.1-to-0.2.md describes.`);
  const features = v.features as Feature[];
  if (v.version !== 2 || !IDENTITIES.includes(v.identity as Identity) || !Array.isArray(features) || FEATURES.filter((f) => features.includes(f)).join() !== features.join())
    throw new Error(`${CONFIG} must be { "version": 2, "identity": ${IDENTITIES.map((i) => `"${i}"`).join(" | ")}, "features": a subset of ${FEATURES.join(", ")} in that order }.`);
  if ("dialect" in v && (typeof v.dialect !== "string" || !v.dialect)) throw new Error(`${CONFIG} "dialect" must be a module name: "sqlite", "postgres" or a dialect package.`);
  if ("host" in v && !HOSTS.includes(v.host as Host)) throw new Error(`${CONFIG} "host" must be one of ${HOSTS.map((h) => `"${h}"`).join(", ")}.`);
  return { config: { version: 2, identity: v.identity as Identity, features, ...(typeof v.host === "string" ? { host: v.host as Host } : {}), ...(typeof v.dialect === "string" ? { dialect: v.dialect } : {}) }, raw: v };
}

/** The dialect's compile side: `<dialect>/compile`, resolved from the project as a bundler would, or the built-in D1. */
async function loadDialect(root: string, dialect: string | undefined): Promise<SqlDialect> {
  const builtIn = builtInOf(dialect);
  if (builtIn || dialect === undefined) return builtIn === "postgres" ? pg : d1;
  // a package name, never a path: the config must not make generate run a file outside node_modules
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(\/[a-z0-9-._~]+)*$/.test(dialect) || dialect.split("/").some((p) => p === "." || p === ".."))
    throw new Error(`${CONFIG} "dialect" must be a package name (or sqlite, postgres); got ${JSON.stringify(dialect)}.`);
  let path: string;
  try {
    // the package's exports must give <dialect>/compile a `default` (or `require`) condition, which require.resolve reads
    path = createRequire(join(root, "package.json")).resolve(`${dialect}/compile`);
  } catch (err) {
    throw new Error(`${CONFIG} names the dialect ${dialect}, and ${dialect}/compile cannot be found (${(err as NodeJS.ErrnoException).code ?? "error"}). Install it; mantle generate never installs packages.`);
  }
  const mod = await import(pathToFileURL(path).href) as Partial<SqlDialect>;
  if (mod.name !== dialect || typeof mod.version !== "string" || typeof mod.accepts !== "function")
    throw new Error(`${dialect}/compile is not a dialect's compile side: it must export name "${dialect}", a version string and accepts().`);
  return mod as SqlDialect;
}

/** The selection: saved config, then flags. An explicit `--features` without `--identity` means `none` (decision 12). */
function select(saved: MantleConfig | undefined, features: string | undefined, identity: string | undefined, host?: string, dialect?: string): MantleConfig {
  if (identity !== undefined && !IDENTITIES.includes(identity as Identity)) throw new Error(`--identity must be one of ${IDENTITIES.join(", ")}; got ${identity}`);
  if (host !== undefined && !HOSTS.includes(host as Host)) throw new Error(`--host must be one of ${HOSTS.join(", ")}; got ${host}`);
  if (dialect !== undefined && !dialect) throw new Error("--dialect must be sqlite, postgres or a dialect package name");
  if (saved && identity !== undefined && identity !== saved.identity)
    throw new Error(`Switching identity from '${saved.identity}' to '${identity}' on a rerun is refused: it never drops tables. Change ${CONFIG} deliberately once the data is moved.`);
  // the axes are chosen once: another host or engine is a new composition and, for the engine, a data move
  if (saved && host !== undefined && host !== (saved.host ?? "cloudflare"))
    throw new Error(`Switching host from '${saved.host ?? "cloudflare"}' to '${host}' on a rerun is refused: src/service.ts is yours. Change ${CONFIG} and the composition deliberately.`);
  if (saved && dialect !== undefined && (builtInOf(dialect) ?? dialect) !== (builtInOf(saved.dialect) ?? saved.dialect))
    throw new Error(`Switching dialect from '${saved.dialect ?? "sqlite"}' to '${dialect}' on a rerun is refused: the data stays where it is. Change ${CONFIG} deliberately once it is moved.`);
  const picked = features === undefined ? saved?.features ?? FEATURES : features.split(",").map((f) => f.trim()).filter(Boolean);
  const unknown = picked.filter((f) => !FEATURES.includes(f as Feature));
  if (unknown.length) throw new Error(`--features accepts only ${FEATURES.join(", ")}; got ${unknown.join(", ")}`);
  // a flag that restates the saved axis (another spelling was refused above) keeps the saved spelling, so nothing is rewritten
  const h = saved ? saved.host ?? (host === "cloudflare" ? undefined : host) : host;
  const d = saved ? saved.dialect ?? (dialect !== undefined && builtInOf(dialect) === "sqlite" ? undefined : dialect) : dialect;
  return { version: 2, identity: (identity ?? saved?.identity ?? (features === undefined ? "mantle" : "none")) as Identity, features: FEATURES.filter((f) => picked.includes(f)), ...(h ? { host: h as Host } : {}), ...(d ? { dialect: d } : {}) };
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

const HELP = `mantle generate — compile manifests to .mantle/generated/plan.json and mantle.ts, and write the
service preset (src/service.ts, src/index.ts, wrangler.jsonc, ...) once, when src/service.ts does not exist

Usage: mantle generate [options]

Options:
  --manifests <dir>    Manifest directory (default: ./manifests)
  --features <list>    Comma-separated positive list of ${FEATURES.join(", ")} (default: all)
  --identity <kind>    ${IDENTITIES.join(", ")} (default: mantle; none with an explicit --features)
  --host <host>        ${HOSTS.join(", ")} (default: cloudflare); none writes no preset
  --dialect <name>     sqlite (alias d1), postgres, or a dialect package (default: sqlite)
  --check              Write nothing; exit 1 when a generated file or ${CONFIG} is stale
  --database <file>    With --check: a SQLite file (e.g. wrangler's local D1 under .wrangler/state/v3/d1/),
                       opened read-only; prints the SQL storage convergence would run
  -h, --help           This help
`;

export async function runGenerate(rawArgs: readonly string[], deps: GenerateDeps = {}): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: [...rawArgs], options: { manifests: { type: "string" }, features: { type: "string" }, identity: { type: "string" }, host: { type: "string" }, dialect: { type: "string" }, check: { type: "boolean" }, database: { type: "string" }, help: { type: "boolean", short: "h" } } }));
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
  let dialect: SqlDialect;
  try {
    const savedText = await readFile(join(root, CONFIG), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
    saved = savedText === undefined ? undefined : readConfig(savedText);
    config = select(saved?.config, values.features, values.identity, values.host, values.dialect);
    dialect = await loadDialect(root, config.dialect);
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
  // warnings (MCP input shapes, missing tool descriptions) are advice: printed, never a failure
  for (const d of validation.diagnostics) if (d.severity === "warning") stderr.write(`warning: ${d.code} ${d.path}: ${d.message}\n`);
  const compiled = await compileLinkedPlan(validation.linked, dialect);
  // the storage dry-run is the SQLite dialect's; a preset is written for the built-in dialects on Cloudflare (ADR-0036)
  const builtIn = dialect === d1;
  const host = config.host ?? "cloudflare";
  const preset = host === "cloudflare" ? builtInOf(config.dialect) : undefined;
  if (!builtIn && values.database !== undefined) return (stderr.write(`--database is a SQLite file for the sqlite dialect; ${dialect.name} plans its own storage.\n`), 2);
  if (!compiled.ok) return (print(compiled.diagnostics), 1);

  const missing = featureDiagnostics(root, config);
  if (missing.length) return (print(missing), 1);
  // the grammar has no rule across cron fields, so the Cloudflare preset's refusals come before anything is written
  const unmappable = Object.entries(compiled.plan.triggers).flatMap(([name, t]) => {
    if (host !== "cloudflare" || t.source.kind !== "schedule" || t.source.enabled === false) return [];
    try {
      return (toCloudflareCron(t.source.cron), []);
    } catch (err) {
      return [`Trigger ${name}: ${(err as Error).message}\n`];
    }
  });
  if (unmappable.length) return (unmappable.forEach((m) => stderr.write(m)), 1);

  // the source hash is the manifests as authored, keyed by name so the project's location never enters it
  const sourceHash = createHash("sha256").update(JSON.stringify(files.map((f) => [f.name, f.text]))).digest("hex");
  const outputs: [string, string][] = [
    [join(OUT, "plan.json"), json({ sourceHash, plan: compiled.plan })],
    [join(OUT, "mantle.ts"), emitMantleModule(compiled.plan, validation.linked)],
  ];
  // the config is rewritten only when the selection changes, and keeps whatever else it holds
  const changed = (a: MantleConfig | undefined, b: MantleConfig) => !a || a.identity !== b.identity || a.features.join() !== b.features.join() || a.host !== b.host || a.dialect !== b.dialect;
  if (changed(saved?.config, config))
    outputs.push([CONFIG, json({ ...saved?.raw, version: 2, identity: config.identity, features: config.features, ...(config.host ? { host: config.host } : {}), ...(config.dialect ? { dialect: config.dialect } : {}) })]);

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
    stdout.write(`Generated ${OUT}/plan.json and ${OUT}/mantle.ts (fingerprint ${compiled.plan.fingerprint.slice(0, 12)}; identity ${config.identity}; features ${config.features.join(", ") || "none"}${host === "cloudflare" ? "" : `; host ${host}`}${builtIn ? "" : `; dialect ${dialect.name}`}).\n`);
    if (!preset) {
      if (host === "cloudflare") stdout.write(`No preset for the dialect ${dialect.name}: compose src/service.ts with its storage adapter.\n`);
      return 0;
    }
    const selection = { ...config, dialect: preset };
    let written: string[];
    try {
      written = await writePreset(root, selection, compiled.plan);
    } catch (err) {
      return (stderr.write(`${err instanceof Error ? err.message : String(err)}; rerun mantle generate to finish the preset.\n`), 2);
    }
    // host and dialect cannot change on a rerun (select refuses it), so only the identity and features can drift from src/service.ts
    const selectionChanged = !!saved && (saved.config.identity !== config.identity || saved.config.features.join() !== config.features.join());
    for (const w of await presetWarnings(root, selection, selectionChanged, compiled.plan)) stderr.write(`warning: ${w}\n`);
    if (written.length) stdout.write(`Wrote the service preset, which is yours to edit: ${written.join(", ")}.\n`);
    return 0;
  }

  let code = 0;
  for (const [path, text] of outputs) {
    if ((await readText(join(root, path))) === text) continue;
    stderr.write(`stale: ${path}\n`);
    code = 1;
  }
  if (code) stderr.write("Mantle generated files are stale; run `mantle generate`.\n");

  if (!builtIn || (!deps.driver && values.database === undefined)) return code;
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
