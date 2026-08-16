import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseManifestSources,
  ValidateManifestsUseCase,
} from "../src/index.js";

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/pipeline-v0.1/${name}`, import.meta.url)),
    "utf8",
  );

describe("v0.1 sealed-pipeline characterization", () => {
  it("freezes successful parse and semantic validation", () => {
    const parsed = parseManifestSources({
      sources: [{ sourceId: "fixture:valid.yaml", text: fixture("valid.yaml") }],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
    if (!parsed.ok) throw new Error("expected valid characterization fixture");
    const validated = ValidateManifestsUseCase.run({
      manifests: parsed.value.entries.map((entry) => entry.manifest),
    });
    expect(validated.diagnostics).toEqual([]);
    expect({ parsed, validated }).toMatchSnapshot();
  });

  it("freezes source-aware parse diagnostic order and withholds partial values", () => {
    const parsed = parseManifestSources({
      sources: [{ sourceId: "fixture:parse-invalid.yaml", text: fixture("parse-invalid.yaml") }],
    });

    expect(parsed.ok).toBe(false);
    expect("value" in parsed).toBe(false);
    expect(parsed).toMatchSnapshot();
  });

  it("keeps the pre-link semantic diagnostic order characterized", () => {
    const parsed = parseManifestSources({
      sources: [{ sourceId: "fixture:link-invalid.yaml", text: fixture("link-invalid.yaml") }],
    });

    if (!parsed.ok) throw new Error("expected structurally valid link fixture");
    const validated = ValidateManifestsUseCase.run({
      manifests: parsed.value.entries.map((entry) => entry.manifest),
    });
    expect(validated.diagnostics).toMatchSnapshot();
  });
});
