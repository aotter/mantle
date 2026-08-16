import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseManifests,
  ValidateManifestsUseCase,
} from "../src/index.js";

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/pipeline-v0.1/${name}`, import.meta.url)),
    "utf8",
  );

describe("v0.1 sealed-pipeline characterization", () => {
  it("freezes successful parse and semantic validation", () => {
    const parsed = parseManifests(fixture("valid.yaml"));
    const validated = ValidateManifestsUseCase.run({ manifests: parsed.manifests });

    expect(parsed.diagnostics).toEqual([]);
    expect(validated.diagnostics).toEqual([]);
    expect({ parsed, validated }).toMatchSnapshot();
  });

  it("freezes parse and semantic diagnostic order", () => {
    const parsed = parseManifests(fixture("invalid.yaml"));
    const validated = ValidateManifestsUseCase.run({ manifests: parsed.manifests });

    expect({
      parseDiagnostics: parsed.diagnostics,
      validateDiagnostics: validated.diagnostics,
    }).toMatchSnapshot();
  });
});
