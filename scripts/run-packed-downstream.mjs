#!/usr/bin/env node
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packages = [
  ["@aotter/mantle-spec", "packages/mantle-spec"],
  ["@aotter/mantle-admin-ui", "packages/mantle-admin-ui"],
  ["@aotter/mantle-runtime", "packages/mantle-runtime"],
  ["@aotter/mantle-cloudflare", "packages/adapters/cloudflare"],
  ["@aotter/mantle", "packages/mantle"],
];

const separator = process.argv.indexOf("--");
const args = separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
const command = separator < 0 ? [] : process.argv.slice(separator + 1);
const projectIndex = args.indexOf("--project");
const projectArg = projectIndex >= 0 ? args[projectIndex + 1] : null;
const packageProjectIndex = args.indexOf("--package-project");
const packageProjectArg = packageProjectIndex >= 0 ? args[packageProjectIndex + 1] : null;
const keep = args.includes("--keep");
if (
  (!projectArg && !packageProjectArg)
  || (projectArg && packageProjectArg)
  || command.length === 0
  || args.includes("--help")
  || args.includes("-h")
) {
  console.log(`Usage: node scripts/run-packed-downstream.mjs (--project <path> | --package-project <path>) -- <command> [args...]

Copies the downstream project to a temporary directory, installs exact tarballs
packed from this checkout (including transitive @aotter/mantle-* overrides),
then runs the command there. --package-project selects a recipe shipped inside
the packed @aotter/mantle tarball. The source project is never modified. Pass
--keep to retain and print the temporary directory for manual probes.`);
  process.exit((projectArg || packageProjectArg) && command.length ? 0 : 2);
}

let project = projectArg ? resolve(root, projectArg) : null;
if (project && !(await stat(project).catch(() => null))?.isDirectory()) {
  throw new Error(`downstream project does not exist: ${project}`);
}

const tempRoot = await mkdtemp(join(tmpdir(), "mantle-packed-downstream-"));
const artifacts = join(tempRoot, "artifacts");
const downstream = join(tempRoot, "project");
try {
  await mkdir(artifacts);
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const tarballs = new Map();
  for (const [name, directory] of packages) {
    await run(
      "pnpm",
      ["-C", join(root, directory), "pack", "--pack-destination", artifacts],
      root,
      {},
      true,
    );
    const filename = `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
    const path = join(artifacts, filename);
    if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`pack did not create ${path}`);
    tarballs.set(name, path);
  }

  if (packageProjectArg) {
    if (packageProjectArg.startsWith("..") || resolve("/package", packageProjectArg) === "/") {
      throw new Error(`invalid package project path: ${packageProjectArg}`);
    }
    const unpacked = join(tempRoot, "packed-umbrella");
    await mkdir(unpacked);
    await run("tar", ["-xzf", tarballs.get("@aotter/mantle"), "-C", unpacked], root);
    project = resolve(unpacked, "package", packageProjectArg);
    const packedRoot = resolve(unpacked, "package");
    if (!project.startsWith(`${packedRoot}/`) || !(await stat(project).catch(() => null))?.isDirectory()) {
      throw new Error(`packed package project does not exist: ${packageProjectArg}`);
    }
  }
  if (!project) throw new Error("downstream project was not resolved");

  await cp(project, downstream, {
    recursive: true,
    filter: (source) => !ignoredCopyPath(source, project),
  });
  const packageJsonPaths = await findPackageJson(downstream);
  if (packageJsonPaths.length === 0) throw new Error("downstream project has no package.json");
  for (const path of packageJsonPaths) await rewritePackageJson(path, tarballs);
  await addRootOverrides(join(downstream, "package.json"), tarballs);

  await run("pnpm", ["install", "--no-frozen-lockfile"], downstream);
  const installed = await findInstalledPackages(downstream, packages.map(([name]) => name));
  for (const [name] of packages) {
    const paths = installed.get(name) ?? [];
    if (paths.length === 0) throw new Error(`downstream install did not contain ${name}`);
    for (const path of paths) {
      const actual = await realpath(path);
      if (actual.startsWith(root)) throw new Error(`downstream linked ${name} to Core: ${actual}`);
      const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
      if (manifest.version !== version) {
        throw new Error(`downstream resolved ${name} ${manifest.version}; expected ${version}`);
      }
    }
  }

  await run(command[0], command.slice(1), downstream, {
    MANTLE_PACKED_ARTIFACT_DIR: artifacts,
  });
  console.log(`packed downstream passed: ${packageProjectArg ?? basename(project)} @ ${version}`);
} finally {
  if (keep) console.log(`packed downstream retained: ${tempRoot}`);
  else await rm(tempRoot, { recursive: true, force: true });
}

async function rewritePackageJson(path, tarballs) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const tarball = tarballs.get(name);
      if (tarball) manifest[section][name] = `file:${tarball}`;
    }
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function addRootOverrides(path, tarballs) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.pnpm ??= {};
  manifest.pnpm.overrides = {
    ...(manifest.pnpm.overrides ?? {}),
    ...Object.fromEntries([...tarballs].map(([name, tarball]) => [name, `file:${tarball}`])),
  };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function findPackageJson(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await findPackageJson(path));
    else if (entry.isFile() && entry.name === "package.json") paths.push(path);
  }
  return paths;
}

async function findInstalledPackages(directory, names, found = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name === ".git") continue;
    if (entry.name === "node_modules") {
      for (const name of names) {
        const candidate = join(path, ...name.split("/"));
        if ((await stat(candidate).catch(() => null))?.isDirectory()) addFound(found, name, candidate);
      }
      const store = join(path, ".pnpm");
      for (const packageEntry of await readdir(store).catch(() => [])) {
        for (const name of names) {
          const candidate = join(store, packageEntry, "node_modules", ...name.split("/"));
          if ((await stat(candidate).catch(() => null))?.isDirectory()) addFound(found, name, candidate);
        }
      }
      continue;
    }
    await findInstalledPackages(path, names, found);
  }
  return found;
}

function addFound(found, name, path) {
  const paths = found.get(name) ?? [];
  if (!paths.includes(path)) paths.push(path);
  found.set(name, paths);
}

function ignoredCopyPath(source, projectRoot) {
  const relative = source.slice(projectRoot.length).replace(/^\/+/, "");
  return relative.split("/").some((part) =>
    part === ".git" ||
    part === "node_modules" ||
    part === "dist" ||
    part.startsWith(".wrangler") ||
    part === ".dev.vars" ||
    part === ".dev.vars.test"
  );
}

async function run(executable, args, cwd, extraEnv = {}, quiet = false) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        `${executable} ${args.join(" ")} exited ${code ?? signal}${output ? `\n${output}` : ""}`,
      ));
    });
  });
}
