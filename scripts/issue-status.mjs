#!/usr/bin/env node
/**
 * Issue status automation. Dependency-free; run by workflows, tested by --self-test.
 *
 *   node scripts/issue-status.mjs merged     PR merged into develop (reads GITHUB_EVENT_PATH):
 *                                            label, comment on and close each issue it closes
 *   node scripts/issue-status.mjs released   after a release (env VERSION, RELEASE_URL): comment on and
 *                                            unlabel every closed `pending-release` issue; never exits non-zero
 *   node scripts/issue-status.mjs --self-test
 *
 * GitHub closes an issue from `Closes #N` only when the PR merges into the default branch (`main`), but feature
 * PRs merge into `develop`. See docs/release-process.md, "Close the shipped issues".
 *
 * Closing grammar, from GitHub's "Linking a pull request to an issue" documentation: the keywords close, closes,
 * closed, fix, fixes, fixed, resolve, resolves, resolved (any case), an optional colon, then ONE reference:
 * `#N`, `OWNER/REPO#N` or `https://github.com/OWNER/REPO/issues/N`. Every issue needs its own keyword
 * ("Fixes #1, #2" closes only #1). Other repositories, fenced code blocks and HTML comments never count.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LABEL = { name: "pending-release", color: "ededed", description: "Merged into develop; not in a release yet" };
const KEYWORD = "(?<![\\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \\t]+";
const REFERENCE =
  "(?:https://github\\.com/([\\w.-]+)/([\\w.-]+)/issues/(\\d+)|([\\w.-]+)/([\\w.-]+)#(\\d+)|#(\\d+))(?![\\w/#-])";

/** Issue numbers a PR body closes in `repo` ("owner/name"), in order, without duplicates. */
export function closingReferences(body, repo) {
  // One pass, leftmost wins: a fence hides a comment opener and a comment hides a fence opener.
  const text = String(body ?? "").replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))|<!--[\s\S]*?(?:-->|(?![\s\S]))/gm,
    "",
  );
  const numbers = [];
  for (const m of text.matchAll(new RegExp(KEYWORD + REFERENCE, "gi"))) {
    const owner = m[1] ?? m[4];
    const name = m[2] ?? m[5];
    if (owner !== undefined && `${owner}/${name}`.toLowerCase() !== repo.toLowerCase()) continue;
    const number = Number(m[3] ?? m[6] ?? m[7]);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

function selfTest() {
  const repo = "aotter/mantle";
  const refs = body => closingReferences(body, repo);
  assert.deepEqual(refs("Closes #12"), [12]);
  assert.deepEqual(refs("closes: #12"), [12]);
  assert.deepEqual(refs("FIXED #3\nResolved: #4"), [3, 4]);
  assert.deepEqual(refs("Fixes #1, #2"), [1], "only the referenced issue directly after a keyword closes");
  assert.deepEqual(refs("Fixes #1, fixes #2 and resolves #1"), [1, 2]);
  assert.deepEqual(refs("Closes aotter/mantle#12"), [12]);
  assert.deepEqual(refs("Closes AOTTER/Mantle#12"), [12]);
  assert.deepEqual(refs("Closes https://github.com/aotter/mantle/issues/12"), [12]);
  assert.deepEqual(refs("Closes other/repo#12\nCloses https://github.com/other/repo/issues/13"), []);
  assert.deepEqual(refs("Refs #12\nRelated to #13\nSee #14"), []);
  assert.deepEqual(refs("Closes # 12\nCloses #\nCloses #12abc\nCloses #1/2"), []);
  assert.deepEqual(refs("Disclosed #12\nenclosed #13\nunfixes #14"), []);
  assert.deepEqual(refs("Closes\n#12"), []);
  assert.deepEqual(refs("<!-- Closes #12 -->\nRefs #\n"), []);
  assert.deepEqual(refs("<!--\nCloses #12\n-->\nCloses #13"), [13]);
  assert.deepEqual(refs("```\nCloses #12\n```\nCloses #13"), [13]);
  assert.deepEqual(refs("~~~md\nCloses #12\n~~~\nCloses #13"), [13]);
  assert.deepEqual(refs("```\nCloses #12 (never closed fence)"), []);
  assert.deepEqual(refs("<!-- unterminated Closes #12"), []);
  assert.deepEqual(refs("Closes #12\n<!--\n```\n-->\nCloses #13"), [12, 13]);
  assert.deepEqual(refs(null), []);
  console.log("issue-status self-test passed");
}

const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
const repository = process.env.GITHUB_REPOSITORY;
const call = async (method, path, body, allowed = []) => {
  const response = await fetch(`${api}/repos/${repository}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok && !allowed.includes(response.status)) {
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  }
  return { status: response.status, data: response.status === 204 ? null : await response.json().catch(() => null) };
};

async function merged() {
  const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (!pr.merged || pr.base.ref !== "develop") {
    console.log(`PR #${pr.number}: not merged into develop; nothing to do.`);
    return;
  }
  const numbers = closingReferences(pr.body, repository);
  console.log(`PR #${pr.number} closes: ${numbers.length ? numbers.map(n => `#${n}`).join(", ") : "nothing"}`);
  if (!numbers.length) return;
  await call("POST", "/labels", LABEL, [422]);
  let failed = false;
  for (const number of numbers) {
    try {
      const { status, data: issue } = await call("GET", `/issues/${number}`, undefined, [404]);
      if (status === 404 || issue.pull_request || issue.state !== "open") {
        console.log(`#${number}: missing, a pull request or already closed; skipped.`);
        continue;
      }
      await call("POST", `/issues/${number}/labels`, { labels: [LABEL.name] });
      await call("POST", `/issues/${number}/comments`, {
        body: `Merged into develop by #${pr.number}; it ships in the next release.`,
      });
      await call("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
      console.log(`#${number}: labelled ${LABEL.name} and closed.`);
    } catch (error) {
      failed = true;
      console.log(`::error::#${number}: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function released() {
  const { VERSION: version, RELEASE_URL: url } = process.env;
  try {
    const issues = [];
    for (let page = 1; ; page++) {
      const { data } = await call("GET", `/issues?state=closed&labels=${LABEL.name}&per_page=100&page=${page}`);
      issues.push(...data.filter(issue => !issue.pull_request));
      if (data.length < 100) break;
    }
    console.log(`${issues.length} closed ${LABEL.name} issue(s) to mark as released in ${version}.`);
    for (const { number } of issues) {
      try {
        await call("POST", `/issues/${number}/comments`, {
          body: `Released in ${url ? `[${version}](${url})` : version}.`,
        });
        await call("DELETE", `/issues/${number}/labels/${LABEL.name}`, undefined, [404]);
        console.log(`#${number}: marked released.`);
      } catch (error) {
        console.log(`::warning::#${number}: ${error.message}`);
      }
    }
  } catch (error) {
    console.log(`::warning::Issue status after release failed: ${error.message}`);
  }
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === "merged") await merged();
else if (mode === "released") await released();
else if (process.argv[1].endsWith("issue-status.mjs")) {
  console.error("usage: issue-status.mjs merged | released | --self-test");
  process.exitCode = 2;
}
