// @ts-nocheck bench files are plain .mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TARGETS, mapCoverage } from "../../bench/lib/counters.mjs";

const ROOT = "file:///fake/packages/mantle/";
const script = (path, ...fns) => ({ url: path.startsWith("file:") ? path : `${ROOT}${path}`, functions: fns.map(([functionName, count]) => ({ functionName, ranges: [{ count }] })) });

describe("mapCoverage", () => {
  it("sums counts per key across the dialect files and ignores same-named functions outside the package", () => {
    const { counts, status } = mapCoverage([
      script("dist/d1/validator.js", ["validateIr", 2]),
      script("dist/postgres/validator.js", ["validateIr", 3]),
      script("dist/core/sql/allowlist.js", ["validateIr", 99]), // the delegate: not a target file
      script("dist/d1/print.js", ["print", 4], ["other", 7]),
      script("file:///elsewhere/node_modules/x/dist/d1/print.js", ["print", 50]),
      script("file:///fake/node_modules/pgsql-deparser/esm/deparser.js", ["deparse", 6]),
    ], ROOT);
    expect(counts.check).toBe(5);
    expect(counts.print).toBe(4);
    expect(counts.deparse).toBe(6);
    expect(status.print).toBe("ok");
  });

  it("is not-loaded when the file never appeared, and missing when it is loaded without the function", () => {
    const { counts, status } = mapCoverage([script("dist/core/sql/run.js", ["runView", 1]), script("dist/core/sql/compile.js", ["renamedCompile", 8])], ROOT);
    expect(status.compile).toBe("missing");
    expect(counts.compile).toBe(0);
    expect(status.paged).toBe("missing"); // run.js is loaded, pagedOf is not in it
    expect(status.zod).toBe("not-loaded");
    expect(counts.zod).toBe(0);
  });

  it("remembers loaded files across takes (a take reports only what changed)", () => {
    const state = { seen: new Map() };
    mapCoverage([script("dist/core/sql/policy.js", ["applyPolicy", 1])], ROOT, state);
    const second = mapCoverage([], ROOT, state);
    expect(second.status.policy).toBe("ok");
    expect(second.counts.policy).toBe(0);
  });

  it("has one row per documented key", () => {
    expect(TARGETS.map((t) => t.key)).toEqual(["compile", "check", "policy", "paged", "print", "zod", "storeIr", "deparse"]);
  });
});

describe("live coverage", () => {
  const dist = join(import.meta.dirname, "../../dist/d1/print.js");
  it.skipIf(!existsSync(dist))("counts one print call in a fresh process", () => {
    // coverage must start before the import, so it runs in its own process, as the harness does
    const out = execFileSync(process.execPath, [join(import.meta.dirname, "counters-live.mjs"), dist], { encoding: "utf8" });
    const { counts, status } = JSON.parse(out);
    expect(counts.print).toBe(1);
    expect(status.print).toBe("ok");
  }, 60_000);
});

describe("mapCoverage with the script source", () => {
  it("a function V8 never reported is still defined when the file's text defines it, and missing when it does not", () => {
    const scripts = [script("dist/core/store/json.js", ["other", 1]), script("dist/core/sql/compile.js", ["other", 1])];
    const sources = { [`${ROOT}dist/core/store/json.js`]: "class StoreJson {\n    select(q) {\n        return 1;\n    }\n}", [`${ROOT}dist/core/sql/compile.js`]: "export function renamedCompile(a) {}" };
    const { status } = mapCoverage(scripts, ROOT, { seen: new Map() }, (url) => sources[url]);
    expect(status.storeIr).toBe("ok");
    expect(status.compile).toBe("missing");
  });
});
