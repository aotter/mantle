#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

if (process.argv[2] === "--channels") {
  console.log(releaseChannels(process.argv[3]).join(" "));
  process.exit(0);
}

if (process.argv[2] === "--self-test") {
  assert.deepEqual(releaseChannels("0.0.11-alpha.63"), ["alpha"]);
  assert.deepEqual(releaseChannels("0.1.0-alpha.17"), ["alpha"]);
  assert.deepEqual(releaseChannels("0.1.2-alpha.1"), ["alpha"]);
  assert.deepEqual(releaseChannels("0.1.2-beta.1"), ["beta"]);
  assert.deepEqual(releaseChannels("0.1.2-rc.1"), ["rc"]);
  assert.deepEqual(releaseChannels("0.1.2"), ["latest"]);
  assert.throws(() => releaseChannels("0.1.2-preview.1"), /Unsupported/);
  const ancestor = (left, right) => left === "old" && right === "new";
  assert.equal(decide("same", "same", ancestor), "same");
  assert.equal(decide("new", "old", ancestor), "advance");
  assert.equal(decide("old", "new", ancestor), "preserve");
  assert.throws(() => decide("left", "right", ancestor), /not comparable/);

  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const steps = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);
  const ordered = [
    "Check Core source",
    "Pack release tarballs", "Verify release credentials", "Create immutable Core tag",
    "Publish to npmjs", "Verify immutable npm artifacts", "Mirror to GitHub Packages",
    "Verify public-registry Core in the reference Worker",
    "Promote npmjs channel tags", "Promote GitHub Packages channel tags", "Create GitHub release",
  ];
  let previous = -1;
  for (const name of ordered) {
    const index = steps.indexOf(name);
    assert(index > previous, `${name} must occur once in release order`);
    assert.equal(steps.lastIndexOf(name), index);
    previous = index;
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert(pkg.scripts.check.includes("pnpm check:worker-consumer"));
  assert.match(workflow, /- name: Check Core source\n        run: pnpm check/);
  assert.doesNotMatch(workflow, /mantle-starters|mantle-landing|RELEASE_FANOUT_TOKEN|deploy_landing/);
  assert.match(workflow, /run: node scripts\/check-worker-consumer\.mjs --registry "\$VERSION"/);
  assert.doesNotMatch(workflow, /continue-on-error:/);

  const gate = workflow.indexOf("Verify public-registry Core in the reference Worker");
  const npmPromote = workflow.indexOf("- name: Promote npmjs channel tags");
  const gprPromote = workflow.indexOf("- name: Promote GitHub Packages channel tags");
  const githubRelease = workflow.indexOf("- name: Create GitHub release");
  const removals = [...workflow.matchAll(/(?:gpr_npm |npm )dist-tag rm[^\n]*/g)];
  assert.equal(removals.length, 2);
  assert.match(removals[0][0], /^npm dist-tag rm "\$pkg" mantle-release /);
  assert.match(removals[1][0], /^gpr_npm dist-tag rm "\$pkg" mantle-release$/);
  assert.ok(removals[0].index > npmPromote && removals[0].index < gprPromote);
  assert.ok(removals[1].index > gprPromote && removals[1].index < githubRelease);
  assert.ok(workflow.indexOf("dist-tag add", npmPromote) < removals[0].index);
  assert.ok(workflow.indexOf("dist-tag add", gprPromote) < removals[1].index);
  assert.equal(workflow.slice(0, gate).includes("dist-tag rm"), false);
  const publishTags = [...workflow.matchAll(/--tag mantle-release/g)];
  assert.equal(publishTags.length, 2);
  assert.ok(publishTags[0].index < gate && publishTags[1].index < gate);
  const dropAfterPromote = [...workflow.matchAll(
    /for pkg in \$PKG_NAMES; do\n {12}for channel in \$\(node scripts\/release-tag-order\.mjs --channels "\$VERSION"\); do\n {14}promote "\$pkg" "\$channel"\n {12}done\n {12}drop_temp_tag "\$pkg"\n {10}done/g,
  )];
  assert.equal(dropAfterPromote.length, 2);
  assert.doesNotMatch(workflow, /npm unpublish|dist-tag rm "\$pkg" (?!mantle-release\b)/);
  assert.doesNotMatch(workflow, /gh workflow run remove-mantle-release|workflow_call/);

  const cleanup = readFileSync(
    new URL("../.github/workflows/remove-mantle-release-dist-tag.yml", import.meta.url),
    "utf8",
  );
  assert.equal(cleanup.includes("name: remove-mantle-release-dist-tag"), true);
  assert.match(cleanup, /\[ "\$CONFIRM" = "remove-mantle-release" \]/);
  assert.ok(cleanup.indexOf('"$CONFIRM" = "remove-mantle-release"') < cleanup.indexOf("dist-tag rm"));
  assert.match(cleanup, /group: release-controller\n {2}cancel-in-progress: false/);
  assert.equal(pkgDirs(cleanup).join("\n"), pkgDirs(workflow).join("\n"));
  assert.equal(pkgDirs(cleanup).length, 11);
  const cleanupRemovals = [...cleanup.matchAll(/(?:gpr_npm |npm[^\n]* )dist-tag rm[^\n]*/g)];
  assert.equal(cleanupRemovals.length, 2);
  assert.match(cleanupRemovals[0][0], /dist-tag rm "\$pkg" mantle-release$/);
  assert.match(cleanupRemovals[1][0], /gpr_npm dist-tag rm "\$pkg" mantle-release$/);
  assert.doesNotMatch(cleanup, /dist-tag add|npm publish|npm unpublish|dist-tag rm "\$pkg" (?!mantle-release\b)/);
  assert.match(cleanup, /before: \$before/);
  assert.match(cleanup, /after: \$after/);

  console.log("release self-test passed");
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

function pkgDirs(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes("PKG_DIRS: >-"));
  assert(start >= 0, "PKG_DIRS missing");
  const dirs = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^ {8}(\S+)$/);
    if (!match) break;
    dirs.push(match[1]);
  }
  return dirs;
}

function releaseChannels(version) {
  const prerelease = version.match(/-(alpha|beta|rc)(?:\.|$)/)?.[1];
  if (version.includes("-") && !prerelease) throw new Error(`Unsupported prerelease channel: ${version}`);
  const channel = prerelease ?? "latest";
  return [channel];
}
