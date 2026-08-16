#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const temp = mkdtempSync(join(tmpdir(), "mantle-web-packages-"));
const artifacts = join(temp, "artifacts");
const zod = `file:${realpathSync(join(root, "packages/mantle-runtime/node_modules/zod"))}`;

try {
  mkdirSync(artifacts);
  const tarballs = Object.fromEntries([
    ["@aotter/mantle-spec", "packages/mantle-spec"],
    ["@aotter/mantle-runtime", "packages/mantle-runtime"],
    ["@aotter/mantle-web", "packages/mantle-web"],
  ].map(([name, directory]) => {
    execFileSync("pnpm", ["-C", directory, "pack", "--pack-destination", artifacts], {
      cwd: root,
      stdio: "ignore",
    });
    return [name, join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`)];
  }));

  installConsumer("core-only", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
    zod,
  }, `
    await import("@aotter/mantle-runtime");
  `);
  if (existsSync(join(temp, "core-only/node_modules/@aotter/mantle-web"))) {
    throw new Error("core-only consumer installed @aotter/mantle-web");
  }

  installConsumer("core-with-web", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
    "@aotter/mantle-web": `file:${tarballs["@aotter/mantle-web"]}`,
    zod,
  }, `
    await import("@aotter/mantle-runtime");
    const web = await import("@aotter/mantle-web");
    if (typeof web.createMantleWeb !== "function") throw new Error("missing createMantleWeb");
  `);

  console.log("Packed Core-only and Core+Web consumers passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function installConsumer(name, dependencies, check) {
  const directory = join(temp, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies,
    pnpm: {
      overrides: Object.fromEntries(
        Object.entries(dependencies).filter(([name]) => name.startsWith("@aotter/")),
      ),
    },
  }, null, 2)}\n`);
  execFileSync("pnpm", ["install", "--ignore-scripts"], {
    cwd: directory,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["--input-type=module", "--eval", check], {
    cwd: directory,
    stdio: "inherit",
  });
}
