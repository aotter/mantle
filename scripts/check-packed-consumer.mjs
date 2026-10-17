#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = JSON.parse(execFileSync(
  "pnpm",
  ["--filter", "@aotter/mantle*", "list", "--depth", "-1", "--json"],
  { cwd: root, encoding: "utf8" },
)).filter((pkg) => !pkg.private).map((pkg) => [pkg.name, pkg.path]);
const separator = process.argv.indexOf("--");
const args = separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
// --pm npm | pnpm@<exact>: install the consumer (no lockfile either way) and run the command with that package
// manager instead of the pnpm on PATH, as a user copying an example would.
const pmAt = args.indexOf("--pm");
const pm = pmAt < 0 ? null : args.splice(pmAt, 2)[1];
if (pm !== null && pm !== "npm" && !/^pnpm@\d+\.\d+\.\d+$/.test(pm ?? "")) throw new Error("--pm takes npm or pnpm@<exact version>");
const npm = pm === "npm";
const command = separator < 0 ? [] : process.argv.slice(separator + 1);
const help = args.some((arg) => arg === "-h" || arg === "--help");

if (args.length === 1 && args[0] === "--self-test" && command.length === 0) {
  let rejected = false;
  try {
    assertExactTarballResolutions("version: 0.0.11-alpha.63", new Map([
      ["@aotter/mantle", "/tmp/exact-mantle.tgz"],
    ]));
  } catch (error) {
    rejected = error.message.includes("exact tarball");
  }
  if (!rejected) throw new Error("packed-consumer provenance self-test accepted a registry install");
  const source = join(tmpdir(), "source");
  if (!isWithin(source, join(source, "output")) || isWithin(source, join(tmpdir(), "output"))) {
    throw new Error("packed-consumer output boundary self-test failed");
  }
  const archived = archiveProject(join(root, "docs/examples/reference-service"));
  const entries = execFileSync("tar", ["-tf", "-"], { input: archived.bytes, encoding: "utf8" }).split("\n");
  if (!entries.includes("package.json") || entries.some((entry) => /^(?:node_modules|generated|dist)\//.test(entry))) {
    throw new Error("packed-consumer reference archive must contain authored source without dependencies or generated/build output");
  }
  const probe = join(tmpdir(), "packed-consumer-peer-rules.json");
  writeFileSync(probe, `${JSON.stringify({ name: "probe", private: true }, null, 2)}\n`);
  addOverrides(probe, new Map([["@aotter/mantle", "/tmp/exact-mantle.tgz"]]));
  const patched = JSON.parse(readFileSync(probe, "utf8"));
  rmSync(probe);
  if (!patched.pnpm?.peerDependencyRules?.allowAny?.includes("@aotter/mantle")) {
    throw new Error("packed-consumer peer-rule self-test failed");
  }
  console.log("packed-consumer provenance and subtree self-test passed");
  process.exit(0);
}
if (help) {
  console.log("Usage: node scripts/check-packed-consumer.mjs [--pm npm|pnpm@<version>] --project <path> [--output <path>] -- <command> [args...]");
  process.exit(0);
}
const output = args.length === 4 && args[2] === "--output" && args[3]
  ? resolve(root, args[3])
  : null;
if (
  (args.length !== 2 && !output)
  || args[0] !== "--project"
  || !args[1]
  || command.length === 0
) {
  throw new Error("Usage: node scripts/check-packed-consumer.mjs [--pm npm|pnpm@<version>] --project <path> [--output <path>] -- <command> [args...]");
}
const project = resolve(root, args[1]);
if (!statSync(project, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`consumer project does not exist: ${project}`);
}
if (output && (isWithin(root, output) || isWithin(project, output))) {
  throw new Error("output must be outside the Core and consumer checkouts");
}
if (output && existsSync(output)) throw new Error(`output already exists: ${output}`);
const coreSha = gitSha(root);
const consumerSha = gitSha(project);

const temp = output ?? mkdtempSync(join(tmpdir(), "mantle-packed-consumer-"));
const artifacts = join(temp, "artifacts");
const consumer = join(temp, "consumer");
let complete = false;
try {
  if (output) mkdirSync(temp);
  mkdirSync(artifacts);
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const tarballs = new Map();
  for (const [name, directory] of packages) {
    run("pnpm", ["-C", directory, "pack", "--pack-destination", artifacts], root, true);
    const tarball = join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`pack did not create ${tarball}`);
    tarballs.set(name, tarball);
  }

  const { prefix, bytes } = archiveProject(project);
  mkdirSync(consumer);
  execFileSync("tar", ["-x", "-C", consumer], { input: bytes });
  let env;
  if (pm) {
    // Public registry only: a user ~/.npmrc may scope @aotter to a private registry.
    const npmrc = join(temp, "npmrc");
    writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
    env = { npm_config_userconfig: npmrc, npm_config_registry: "https://registry.npmjs.org/" };
  }
  if (pm?.startsWith("pnpm@")) {
    // That exact pnpm, first on PATH for both the install and the command.
    const tool = join(temp, "tool");
    mkdirSync(tool);
    writeFileSync(join(tool, "package.json"), "{\"private\":true}\n");
    run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", pm], tool, true, env);
    env.PATH = `${join(tool, "node_modules", ".bin")}${delimiter}${process.env.PATH}`;
  }
  if (npm) {
    addNpmOverrides(join(consumer, "package.json"), tarballs);
    run("npm", ["install", "--no-audit", "--no-fund", "--prefer-online"], consumer, false, env);
    const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
    for (const [name, tarball] of tarballs) {
      const resolved = lock.packages?.[`node_modules/${name}`]?.resolved;
      if (!resolved?.startsWith("file:") || realpathSync(resolve(consumer, resolved.slice(5))) !== realpathSync(tarball)) {
        throw new Error(`consumer lock did not resolve ${name} from its exact tarball (got ${resolved})`);
      }
    }
  } else {
    addOverrides(join(consumer, "package.json"), tarballs);
    run("pnpm", ["install", "--no-frozen-lockfile"], consumer, false, env);
    const lockfile = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
    assertExactTarballResolutions(lockfile, tarballs);
  }

  const installed = findInstalled(consumer, packages.map(([name]) => name));
  let installedCount = 0;
  for (const [name] of packages) {
    const paths = installed.get(name) ?? [];
    installedCount += paths.length;
    for (const path of paths) {
      const actual = realpathSync(path);
      if (actual.startsWith(`${root}/`)) throw new Error(`consumer workspace-linked ${name}: ${actual}`);
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      if (manifest.version !== version) {
        throw new Error(`consumer installed ${name}@${manifest.version}; expected ${version}`);
      }
      if (JSON.stringify(manifest).includes("workspace:")) {
        throw new Error(`${name} tarball leaked a workspace: dependency`);
      }
    }
  }
  if (installedCount === 0) throw new Error("consumer did not install any Mantle package");

  run(command[0], command.slice(1), consumer, false, env);
  complete = true;
  console.log(JSON.stringify({
    core_sha: coreSha,
    consumer_sha: consumerSha,
    consumer: basename(project),
    consumer_path: prefix || ".",
    package_manager: pm ?? "pnpm",
    package_version: version,
    run_artifact_sha256: Object.fromEntries(
      [...tarballs].map(([name, path]) => [name, sha256(path)]),
    ),
  }, null, 2));
} finally {
  if (!output || !complete) rmSync(temp, { recursive: true, force: true });
}

function addOverrides(path, tarballs) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.pnpm ??= {};
  manifest.pnpm.overrides = {
    ...(manifest.pnpm.overrides ?? {}),
    ...Object.fromEntries([...tarballs].map(([name, path]) => [name, `file:${path}`])),
  };
  // file: overrides rewrite peer specifiers to file: paths; pnpm 9 then reports
  // "unmet peer @scope/pkg@file:...tgz: found 0.1.2-..." even when that version
  // is installed. allowedVersions: "*" does not silence it; allowAny does.
  // Disposable consumer only — registry peer checks stay.
  manifest.pnpm.peerDependencyRules = {
    ...(manifest.pnpm.peerDependencyRules ?? {}),
    allowAny: [...new Set([
      ...(manifest.pnpm.peerDependencyRules?.allowAny ?? []),
      ...tarballs.keys(),
    ])],
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  // pnpm 10+ ignores the package.json "pnpm" field and reads these from pnpm-workspace.yaml.
  const workspace = join(dirname(path), "pnpm-workspace.yaml");
  if (!existsSync(workspace)) return;
  const yaml = readFileSync(workspace, "utf8");
  if (/^(overrides|peerDependencyRules):/m.test(yaml)) throw new Error(`${workspace} already has overrides; merge them by hand`);
  writeFileSync(workspace, `${yaml.trimEnd()}\noverrides: ${JSON.stringify(manifest.pnpm.overrides)}\npeerDependencyRules: ${JSON.stringify(manifest.pnpm.peerDependencyRules)}\n`);
}

// npm: a direct dependency and its override must carry the same spec, so both point at the tarball.
// The override also catches @aotter/mantle-ui under @aotter/mantle-admin, which would otherwise hit a registry.
function addNpmOverrides(path, tarballs) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const [name, tarball] of tarballs) {
    if (manifest.dependencies?.[name]) manifest.dependencies[name] = `file:${tarball}`;
  }
  manifest.overrides = {
    ...(manifest.overrides ?? {}),
    ...Object.fromEntries([...tarballs].map(([name, tarball]) => [name, `file:${tarball}`])),
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertExactTarballResolutions(lockfile, tarballs) {
  for (const [name, tarball] of tarballs) {
    if (!lockfile.includes(`file:${tarball}`)) {
      throw new Error(`consumer lock did not resolve ${name} from its exact tarball`);
    }
  }
}

function findInstalled(directory, names, found = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.name !== "node_modules") {
      findInstalled(path, names, found);
      continue;
    }
    for (const name of names) addIfDirectory(found, name, join(path, ...name.split("/")));
    const store = join(path, ".pnpm");
    if (!existsSync(store)) continue;
    for (const packageEntry of readdirSync(store, { withFileTypes: true })) {
      if (!packageEntry.isDirectory()) continue;
      for (const name of names) {
        addIfDirectory(found, name, join(store, packageEntry.name, "node_modules", ...name.split("/")));
      }
    }
  }
  return found;
}

function addIfDirectory(found, name, path) {
  let stats;
  try {
    stats = statSync(path, { throwIfNoEntry: false });
  } catch {
    return;
  }
  if (!stats?.isDirectory()) return;
  const paths = found.get(name) ?? [];
  if (!paths.includes(path)) paths.push(path);
  found.set(name, paths);
}

function run(command, args, cwd, quiet = false, extraEnv = {}) {
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, CI: "1", ...extraEnv },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function gitSha(directory) {
  const top = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (!isWithin(realpathSync(top), realpathSync(directory))) {
    throw new Error(`${directory} is outside its git checkout`);
  }
  const status = execFileSync("git", ["-C", directory, "status", "--porcelain"], { encoding: "utf8" }).trim();
  if (status) throw new Error(`${directory} is not clean; refusing immutable SHA evidence`);
  const sha = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`cannot record immutable git SHA for ${directory}`);
  return sha;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function archiveProject(directory) {
  const top = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const prefix = execFileSync("git", ["-C", directory, "rev-parse", "--show-prefix"], { encoding: "utf8" }).trim().replace(/\/$/, "");
  const bytes = execFileSync("git", ["-C", top, "archive", prefix ? `HEAD:${prefix}` : "HEAD"], { maxBuffer: 64 * 1024 * 1024 });
  return { prefix, bytes };
}

/** One JSON-RPC answer, sent as JSON or as a single-event SSE stream. */
