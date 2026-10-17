import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFromSources } from "../src/infrastructure/generate.js";

const doc = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const procedure = (name: string, admin = false) => doc("Procedure", name, {
  description: `Run ${name}.`,
  ...(admin ? { requires: { auth: { all: ["ctx.admin"] } } } : {}),
  input: { type: "object" }, output: { type: "object" }, handler: { ref: name },
});
const trigger = (name: string, procedure: string, source: object) => doc("Trigger", name, { source, target: { procedure } });

test("generation warns once per HTTP-only Procedure and suggests its audience", async () => {
  const text = [
    procedure("submit"),
    procedure("approve", true),
    procedure("paired"),
    trigger("submit-http", "submit", { kind: "http", method: "POST", path: "/api/submit" }),
    trigger("submit-http-again", "submit", { kind: "http", method: "PUT", path: "/api/submit" }),
    trigger("approve-http", "approve", { kind: "http", method: "POST", path: "/api/approve" }),
    trigger("paired-http", "paired", { kind: "http", method: "POST", path: "/api/paired" }),
    trigger("paired-mcp", "paired", { kind: "mcp", surface: "admin" }),
  ].join("\n---\n");
  const result = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{ sourceId: "app.yaml", text }] } });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.warnings).toEqual([
    expect.stringMatching(/Procedure 'submit'.*user's AI cannot reach.*surface: public.*procedure: submit/),
    expect.stringMatching(/Procedure 'approve'.*user's AI cannot reach.*surface: admin.*procedure: approve/),
  ]);
});

test("public Views keep their generated REST route and MCP tool without a warning", async () => {
  const text = doc("View", "status", { surface: "public", sql: "SELECT 'ok' AS value" });
  const result = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{ sourceId: "view.yaml", text }] } });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.warnings).toEqual([]);
  expect(result.files["rest.ts"]).toContain("/api/views/status");
  expect(result.files["mcp.ts"]).toContain('target: {"kind":"view","name":"status"}');
});

test("CLI warns on stderr, succeeds, and never implies an MCP surface", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mantle-http-only-"));
  try {
    const source = join(dir, "app.yaml");
    const http = [procedure("submit"), trigger("submit-http", "submit", { kind: "http", method: "POST", path: "/api/submit" })];
    await writeFile(source, http.join("\n---\n"));
    const args = [join(import.meta.dir, "../dist/infrastructure/cli.js"), "generate", "bun-sqlite", "generated", source];
    const asymmetric = spawnSync("node", args, { cwd: dir, encoding: "utf8" });
    expect(asymmetric.status).toBe(0);
    expect(asymmetric.stderr.match(/no mcp Trigger/g)).toHaveLength(1);
    const result = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{ sourceId: source, text: http.join("\n---\n") }] } });
    expect(result.ok && result.files["mcp.ts"]).toBeUndefined();
    await writeFile(source, [...http, trigger("submit-mcp", "submit", { kind: "mcp", surface: "public" })].join("\n---\n"));
    const symmetric = spawnSync("node", args, { cwd: dir, encoding: "utf8" });
    expect(symmetric.status).toBe(0);
    expect(symmetric.stderr).toBe("");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
