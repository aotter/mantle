import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifestsFromRoot } from "../src/infrastructure/cli/loadManifests.js";
import {
  parseArgs as parseOpenapiArgs,
  run as runEmitOpenapi,
} from "../src/infrastructure/cli/EmitOpenapiCommand.js";
import {
  parseArgs as parseTypesArgs,
  run as runEmitTypes,
} from "../src/infrastructure/cli/EmitTypesCommand.js";

const SCHEMA_YAML = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  localized: true
  schema:
    type: object
    required: [slug]
    properties:
      slug: { type: string }
      title: { type: string }
      body: { type: string }
      locale: { type: string }
  indexes: [[locale]]
`;

const VIEW_YAML = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: posts-by-locale }
spec:
  surface: public
  from: posts
  params:
    type: object
    properties:
      locale: { type: string }
    required: [locale]
  filter:
    eq: { field: locale, value: { $param: locale } }
`;

const PROC_YAML = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: submitContact }
spec:
  input:
    type: object
    required: [name]
    properties:
      name: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: submitContact }
  requires:
    auth:
      all: [ctx.user]
`;

const TRIGGER_YAML = `apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: submitContactHttp }
spec:
  source: { kind: http, method: POST, path: /api/contact }
  target: { procedure: submitContact }
`;

async function fixtureRoot(fileName = "site.yaml"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantle-cli-"));
  const m = join(dir, "manifests");
  await mkdir(m, { recursive: true });
  await writeFile(join(m, fileName), [SCHEMA_YAML, VIEW_YAML, PROC_YAML, TRIGGER_YAML].join("---\n"));
  return m;
}

describe("loadManifestsFromRoot + partition", () => {
  it("parses a caller-named YAML manifest into all 4 atom buckets", async () => {
    const root = await fixtureRoot("platform.yml");
    const { parsed, parseErrors } = await loadManifestsFromRoot(root);
    expect(parseErrors).toEqual([]);
    const manifests = parsed?.entries.map((entry) => entry.manifest) ?? [];
    const schemas = manifests.filter((manifest) => manifest.kind === "Schema");
    const views = manifests.filter((manifest) => manifest.kind === "View");
    const procedures = manifests.filter((manifest) => manifest.kind === "Procedure");
    const triggers = manifests.filter((manifest) => manifest.kind === "Trigger");
    expect(schemas).toHaveLength(1);
    expect(views).toHaveLength(1);
    expect(procedures).toHaveLength(1);
    expect(triggers).toHaveLength(1);
    expect(schemas[0]!.metadata.name).toBe("posts");
    expect(views[0]!.spec.params?.required).toEqual(["locale"]);
    expect(procedures[0]!.spec.requires?.auth?.all).toEqual(["ctx.user"]);
    expect(triggers[0]!.spec.source).toMatchObject({
      kind: "http",
      method: "POST",
      path: "/api/contact",
    });
  });

  it("sorts files and keeps document indexes local to each source", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "mantle-source-index-")), "manifests");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "z-views.yml"), `---\n---\n${VIEW_YAML}`);
    await writeFile(join(root, "a-schema.yaml"), SCHEMA_YAML);

    const { parsed, parseErrors } = await loadManifestsFromRoot(root);

    expect(parseErrors).toEqual([]);
    expect(parsed?.entries.map(({ manifest, source }) => [
      manifest.kind,
      source.sourceId,
      source.documentIndex,
    ])).toEqual([
      ["Schema", join(root, "a-schema.yaml"), 0],
      ["View", join(root, "z-views.yml"), 1],
    ]);
  });

  it("returns MANIFEST_ROOT_NOT_FOUND when path is missing", async () => {
    const { parsed, parseErrors } = await loadManifestsFromRoot("/nonexistent/path/mantle");
    expect(parsed).toBeUndefined();
    expect(parseErrors[0]?.code).toBe("MANIFEST_ROOT_NOT_FOUND");
  });

  it("returns MANIFEST_ROOT_NOT_FOUND when the directory has no YAML files", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "mantle-empty-manifest-root-")), "manifests");
    await mkdir(root);
    const { parsed, parseErrors } = await loadManifestsFromRoot(root);
    expect(parsed).toBeUndefined();
    expect(parseErrors[0]).toMatchObject({
      code: "MANIFEST_ROOT_NOT_FOUND",
      path: root,
    });
  });
});

describe("emit CLI --output", () => {
  it("writes OpenAPI JSON to a UTF-8 file without shell redirection", async () => {
    const root = await fixtureRoot();
    const output = join(await mkdtemp(join(tmpdir(), "mantle emit out ")), "openapi.json");

    await expect(runEmitOpenapi(["--manifests", root, "--output", output])).resolves.toBe(0);

    const bytes = await readFile(output);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    expect(JSON.parse(text)).toMatchObject({
      openapi: "3.1.0",
      info: { title: "mantle", version: "0.1.0" },
    });
  });

  it("writes TypeScript declarations to a UTF-8 file without shell redirection", async () => {
    const root = await fixtureRoot();
    const output = join(await mkdtemp(join(tmpdir(), "mantle emit out ")), "mantle-types.d.ts");

    await expect(
      runEmitTypes(["--manifests", root, "--namespace", "BlankCms", "--output", output]),
    ).resolves.toBe(0);

    const bytes = await readFile(output);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    expect(text).toContain("export namespace BlankCms");
    expect(text).toContain("interface Entry_posts");
  });

  it("rejects --output without a file path", () => {
    expect(() => parseOpenapiArgs(["--output"])).toThrowError(/--output requires/);
    expect(() => parseTypesArgs(["-o"])).toThrowError(/--output requires/);
  });

  it("fails (exit 1) instead of silently dropping a route on a method+path collision (#398)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mantle-collide-"));
    const m = join(dir, "manifests");
    await mkdir(m, { recursive: true });
    const proc = (name: string) => `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: ${name} }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: ${name} }
`;
    const trig = (name: string, target: string) => `apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: ${name} }
spec:
  source: { kind: http, method: POST, path: /api/foo }
  target: { procedure: ${target} }
`;
    await writeFile(join(m, "site.yaml"), [
      proc("alpha"),
      proc("beta"),
      trig("tAlpha", "alpha"),
      trig("tBeta", "beta"),
    ].join("---\n"));

    await expect(runEmitOpenapi(["--manifests", m])).resolves.toBe(1);
  });
});
