import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run as runValidate } from "../src/infrastructure/cli/ValidateCommand.js";

const SCHEMA_YAML = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: pages }
spec:
  title: Pages
  schema:
    type: object
    required: [slug]
    properties:
      slug: { type: string }
      title: { type: string }
`;

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe("Windows path compatibility", () => {
  it("validates when the project path contains spaces and non-ASCII characters", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mantle Windows 曾 project "));
    const manifests = join(projectRoot, "manifests");
    const source = join(projectRoot, "src");
    await mkdir(manifests, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(join(manifests, "pages.yaml"), SCHEMA_YAML, "utf8");

    process.chdir(projectRoot);

    await expect(runValidate(["--format", "json"])).resolves.toBe(0);
  });
});
