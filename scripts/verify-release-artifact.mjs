#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

if (process.argv[2] === "--self-test") {
  selfTest();
  console.log("release artifact verifier self-test passed");
  process.exit(0);
}

const [expected, actual] = process.argv.slice(2).map((path) => path && resolve(path));
if (!expected || !actual) {
  throw new Error("usage: verify-release-artifact.mjs <expected.tgz> <actual.tgz>");
}
verify(expected, actual);
console.log(`${basename(expected)} and ${basename(actual)} match semantically`);

function verify(expectedTarball, actualTarball) {
  const temp = mkdtempSync(join(tmpdir(), "mantle-release-artifact-"));
  try {
    const expectedDirectory = join(temp, "expected");
    const actualDirectory = join(temp, "actual");
    mkdirSync(expectedDirectory);
    mkdirSync(actualDirectory);
    extract(expectedTarball, expectedDirectory);
    extract(actualTarball, actualDirectory);
    compareTrees(expectedDirectory, actualDirectory);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function extract(tarball, destination) {
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  if (entries.some((path) => path.startsWith("/") || path.split("/").includes(".."))) {
    throw new Error(`${tarball} contains an unsafe path`);
  }
  execFileSync("tar", ["-xzf", tarball, "-C", destination]);
}

function compareTrees(expectedRoot, actualRoot) {
  const expectedEntries = list(expectedRoot);
  const actualEntries = list(actualRoot);
  assert.deepEqual(actualEntries, expectedEntries, "artifact paths differ");

  for (const path of expectedEntries) {
    const expected = join(expectedRoot, path);
    const actual = join(actualRoot, path);
    const expectedStat = lstatSync(expected);
    const actualStat = lstatSync(actual);
    assert.equal(type(actualStat), type(expectedStat), `${path} type differs`);
    if (expectedStat.isSymbolicLink()) {
      assert.equal(readlinkSync(actual), readlinkSync(expected), `${path} link differs`);
    } else if (expectedStat.isFile()) {
      assert.equal(actualStat.mode & 0o777, expectedStat.mode & 0o777, `${path} mode differs`);
      if (basename(path) === "package.json") {
        assert.deepEqual(json(actual), json(expected), `${path} differs`);
      } else {
        assert.deepEqual(readFileSync(actual), readFileSync(expected), `${path} content differs`);
      }
    }
  }
}

function list(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      return entry.isDirectory() ? [name, ...list(root, path)] : [name];
    })
    .sort();
}

function type(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function json(path) {
  return canonicalize(JSON.parse(readFileSync(path, "utf8")));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function selfTest() {
  const temp = mkdtempSync(join(tmpdir(), "mantle-release-artifact-test-"));
  try {
    const expected = fixture(temp, "expected", '{"name":"fixture","dependencies":{"a":"1","b":"2"}}');
    const reordered = fixture(temp, "reordered", '{"dependencies":{"b":"2","a":"1"},"name":"fixture"}');
    verify(expected, reordered);

    const changedJson = fixture(temp, "changed-json", '{"name":"fixture","dependencies":{"a":"1","b":"3"}}');
    assert.throws(() => verify(expected, changedJson), /package.json differs/);

    const changedFile = fixture(temp, "changed-file", '{"name":"fixture","dependencies":{"a":"1","b":"2"}}', "changed\n");
    assert.throws(() => verify(expected, changedFile), /content differs/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function fixture(root, name, manifest, content = "same\n") {
  const directory = join(root, name);
  const packageDirectory = join(directory, "package");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), `${manifest}\n`);
  writeFileSync(join(packageDirectory, "index.js"), content);
  const tarball = join(root, `${name}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", directory, "package"]);
  return tarball;
}
