#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";

if (process.argv[2] === "--self-test") {
  const ancestor = (left, right) => left === "old" && right === "new";
  assert.equal(decide("same", "same", ancestor), "same");
  assert.equal(decide("new", "old", ancestor), "advance");
  assert.equal(decide("old", "new", ancestor), "preserve");
  assert.throws(() => decide("left", "right", ancestor), /not comparable/);
  console.log("release tag order self-test passed");
  process.exit(0);
}

const [candidateSha, currentVersion] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(candidateSha ?? "") || !currentVersion) {
  throw new Error("usage: release-tag-order.mjs <candidate-sha> <current-version>");
}
const currentSha = git("rev-parse", `refs/tags/v${currentVersion}^{commit}`);
console.log(decide(candidateSha, currentSha, isAncestor));

function decide(candidate, current, ancestor) {
  if (candidate === current) return "same";
  if (ancestor(current, candidate)) return "advance";
  if (ancestor(candidate, current)) return "preserve";
  throw new Error(`release commits ${candidate} and ${current} are not comparable`);
}

function isAncestor(left, right) {
  return spawnSync("git", ["merge-base", "--is-ancestor", left, right]).status === 0;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
