// Resolves what is benchmarked: the Mantle package (a dir with a built dist) and the target (the fixture or an
// external `--app`). Never imports Mantle itself; it only computes file URLs for the child process to import.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OWN_PACKAGE_DIR = resolve(BENCH_DIR, "..");
export const DEFAULT_APP = join(BENCH_DIR, "fixtures", "training");

const newestMtime = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((newest, e) => {
    const path = join(dir, e.name);
    return Math.max(newest, e.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }, 0);

/** Walks up from `start` for node_modules/@aotter/mantle/package.json (as cli/generate.ts does). */
export function findInstalledMantle(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@aotter", "mantle");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * A Mantle package dir (packages/mantle of some checkout, or an installed package) with its entry file URLs.
 * It must have been built: dist is what runs, exactly as in production.
 */
export function resolveMantle(dir, { label } = {}) {
  const root = realpathSync(resolve(dir));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.name !== "@aotter/mantle") throw new Error(`${root} is not an @aotter/mantle package dir`);
  const entry = (subpath) => {
    const rel = pkg.exports?.[subpath]?.import;
    if (!rel) throw new Error(`${root}/package.json has no exports["${subpath}"].import`);
    const file = join(root, rel);
    if (!existsSync(file)) throw new Error(`${file} does not exist: build ${root} first (pnpm build)`);
    return pathToFileURL(file).href;
  };
  const core = entry(".");
  if (root === realpathSync(OWN_PACKAGE_DIR)) {
    const dist = statSync(join(root, "dist/core/index.js")).mtimeMs;
    if (newestMtime(join(root, "src")) > dist) throw new Error("dist is stale (src is newer): run pnpm build");
  }
  let sha = "pkg";
  try {
    sha = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "pkg";
  } catch {}
  return {
    dir: root,
    dirUrl: `${pathToFileURL(root).href}/`,
    version: pkg.version,
    sha,
    label: label ?? `${pkg.version}@${sha}`,
    distMtime: statSync(join(root, "dist/core/index.js")).mtimeMs,
    entries: { core, d1: entry("./d1"), postgres: pkg.exports?.["./postgres"] ? entry("./postgres") : undefined },
    bin: join(root, pkg.bin?.mantle ?? "dist/cli/main.js"),
  };
}

/** The app config module: a dir containing mantle.bench.mjs, or the module file itself. */
export async function loadTarget(appPath) {
  const given = resolve(appPath);
  const file = statSync(given).isDirectory() ? join(given, "mantle.bench.mjs") : given;
  if (!existsSync(file)) throw new Error(`no mantle.bench.mjs at ${file}`);
  const configUrl = pathToFileURL(file).href;
  const config = (await import(configUrl)).default;
  const dir = dirname(file);
  if (!config?.name || !config.callers) throw new Error(`${file}: the default export needs at least { name, callers, items }`);
  return { config, configUrl, dir, isFixture: dir === DEFAULT_APP };
}

/** `items` is an array, or a path to a module whose default export is one. */
export async function loadItems(config, dir) {
  if (Array.isArray(config.items)) return config.items;
  return (await import(pathToFileURL(resolve(dir, config.items)).href)).default;
}

/** "module#export" relative to `dir`; the export defaults to `handlers`. */
export async function loadHandlers(spec, dir) {
  if (!spec) return {};
  const [mod, name = "handlers"] = spec.split("#");
  return (await import(pathToFileURL(resolve(dir, mod)).href))[name];
}
