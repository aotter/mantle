import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifestsFromRoot } from "../src/infrastructure/cli/loadManifests.js";
import { partitionManifests } from "../src/domain/service/ManifestParser.js";
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
  schema:
    type: object
    required: [slug]
    properties:
      slug: { type: string }
      title: { type: string }
      body: { type: string }
`;

const VIEW_YAML = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: posts-by-locale }
spec:
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

async function fixtureRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantle-cli-"));
  const m = join(dir, "manifests");
  await mkdir(m, { recursive: true });
  await writeFile(join(m, "posts.yaml"), SCHEMA_YAML);
  await writeFile(join(m, "view.yaml"), VIEW_YAML);
  await writeFile(join(m, "proc.yaml"), PROC_YAML);
  await writeFile(join(m, "trig.yaml"), TRIGGER_YAML);
  return m;
}

describe("loadManifestsFromRoot + partition", () => {
  it("parses a multi-file fixture into all 4 atom buckets", async () => {
    const root = await fixtureRoot();
    const { manifests, parseErrors } = await loadManifestsFromRoot(root);
    expect(parseErrors).toEqual([]);
    const { schemas, views, procedures, triggers } = partitionManifests(manifests);
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

  it("returns MANIFEST_ROOT_NOT_FOUND when path is missing", async () => {
    const { manifests, parseErrors } = await loadManifestsFromRoot("/nonexistent/path/mantle");
    expect(manifests).toHaveLength(0);
    expect(parseErrors[0]?.code).toBe("MANIFEST_ROOT_NOT_FOUND");
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
});
