#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
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
import { basename, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = JSON.parse(execFileSync(
  "pnpm",
  ["--filter", "@aotter/mantle...", "list", "--depth", "-1", "--json"],
  { cwd: root, encoding: "utf8" },
)).filter((pkg) => !pkg.private).map((pkg) => [pkg.name, pkg.path]);
const separator = process.argv.indexOf("--");
const args = separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
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
  console.log("packed-consumer provenance self-test passed");
  process.exit(0);
}
if (help) {
  console.log("Usage: node scripts/check-packed-consumer.mjs --project <path> -- <command> [args...]");
  process.exit(0);
}
if (args.length !== 2 || args[0] !== "--project" || !args[1] || command.length === 0) {
  throw new Error("Usage: node scripts/check-packed-consumer.mjs --project <path> -- <command> [args...]");
}
const project = resolve(root, args[1]);
if (!statSync(project, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`consumer project does not exist: ${project}`);
}
const coreSha = gitSha(root);
const consumerSha = gitSha(project);

const temp = mkdtempSync(join(tmpdir(), "mantle-packed-consumer-"));
const artifacts = join(temp, "artifacts");
const consumer = join(temp, "consumer");
try {
  mkdirSync(artifacts);
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const tarballs = new Map();
  for (const [name, directory] of packages) {
    run("pnpm", ["-C", directory, "pack", "--pack-destination", artifacts], root, true);
    const tarball = join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`pack did not create ${tarball}`);
    tarballs.set(name, tarball);
  }

  cpSync(project, consumer, {
    recursive: true,
    filter: (path) => !ignored(relative(project, path)),
  });
  addOverrides(join(consumer, "package.json"), tarballs);
  run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  const lockfile = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
  assertExactTarballResolutions(lockfile, tarballs);

  const installed = findInstalled(consumer, packages.map(([name]) => name));
  for (const [name] of packages) {
    const paths = installed.get(name) ?? [];
    if (!paths.length) throw new Error(`consumer did not install ${name}`);
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

  run(command[0], command.slice(1), consumer);
  console.log(JSON.stringify({
    core_sha: coreSha,
    consumer_sha: consumerSha,
    consumer: basename(project),
    package_version: version,
    run_artifact_sha256: Object.fromEntries(
      [...tarballs].map(([name, path]) => [name, sha256(path)]),
    ),
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function addOverrides(path, tarballs) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.pnpm ??= {};
  manifest.pnpm.overrides = {
    ...(manifest.pnpm.overrides ?? {}),
    ...Object.fromEntries([...tarballs].map(([name, path]) => [name, `file:${path}`])),
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
    for (const packageEntry of readdirSync(store)) {
      for (const name of names) {
        addIfDirectory(found, name, join(store, packageEntry, "node_modules", ...name.split("/")));
      }
    }
  }
  return found;
}

function addIfDirectory(found, name, path) {
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) return;
  const paths = found.get(name) ?? [];
  if (!paths.includes(path)) paths.push(path);
  found.set(name, paths);
}

function ignored(path) {
  return path.split("/").some((part) =>
    part === ".git"
    || part === "node_modules"
    || part === "dist"
    || part.startsWith(".wrangler")
    || part === ".dev.vars"
    || part === ".dev.vars.test"
  );
}

function run(command, args, cwd, quiet = false) {
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, CI: "1" },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function gitSha(directory) {
  const top = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (realpathSync(top) !== realpathSync(directory)) {
    throw new Error(`${directory} is not the root of its own git checkout`);
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
