import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

// The generator is Node code; optional integrations must not be required just to load it.
test("the generator imports without loading optional Auth or MCP dependencies", () => {
  const hook = `export async function resolve(specifier, context, next) {
    if (/^(?:better-auth(?:\\/|$)|@better-auth\\/|@modelcontextprotocol\\/)/.test(specifier)) throw new Error("optional dependency loaded: " + specifier);
    return next(specifier, context);
  }`;
  const setup = `import { register } from "node:module"; register(${JSON.stringify("data:text/javascript," + encodeURIComponent(hook))}, import.meta.url);`;
  const entry = new URL("../dist/infrastructure/generate.js", import.meta.url).href;
  const fixture = new URL("./apps/purchase.yaml", import.meta.url).href;
  const run = `const { generateFromSources } = await import(${JSON.stringify(entry)});
    const result = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{sourceId: "invalid", text: "kind: Untrusted"}] } });
    if (result.ok || !result.diagnostics.length) throw new Error("invalid manifests must still be refused");
    const { readFileSync } = await import("node:fs");
    const generated = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{sourceId: "purchase", text: readFileSync(new URL(${JSON.stringify(fixture)}), "utf8")}] } });
    if (!generated.ok || !generated.files["schema.sql"]) throw new Error("compiler-only generation failed");
    console.log("compiler-only load passed");`;
  const output = execFileSync(process.env.NODE_BIN ?? "node", ["--import", "data:text/javascript," + encodeURIComponent(setup), "--input-type=module", "--eval", run], {encoding:"utf8"});
  expect(output.trim()).toBe("compiler-only load passed");
});
