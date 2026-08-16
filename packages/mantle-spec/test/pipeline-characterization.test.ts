import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  linkManifestSet,
  parseManifestSources,
  type LinkedManifestSet,
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
    const linked = linkManifestSet(parsed.value);
    expect(linked.diagnostics).toEqual([]);
    if (!linked.ok) throw new Error("expected linked characterization fixture");
    expect({
      parsed: parsed.value.entries.map(({ manifest, source }) => ({ manifest, source })),
      linked: projectLinked(linked.value),
    }).toMatchSnapshot();
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
    const linked = linkManifestSet(parsed.value);
    expect(linked.ok).toBe(false);
    expect("value" in linked).toBe(false);
    expect(linked.diagnostics).toMatchSnapshot();
  });
});

function projectLinked(linked: LinkedManifestSet): unknown {
  return {
    schemas: linked.schemas.map((schema) => ({
      name: schema.manifest.metadata.name,
      translationParent: schema.translationParent?.manifest.metadata.name,
    })),
    views: linked.views.map((view) => ({
      name: view.manifest.metadata.name,
      from: view.from?.manifest.metadata.name,
      guard: view.guard?.manifest.metadata.name,
    })),
    procedures: linked.procedures.map((procedure) => ({
      name: procedure.manifest.metadata.name,
      builtinSchema: procedure.builtinSchema?.manifest.metadata.name,
      collectionActionSchema: procedure.collectionActionSchema?.manifest.metadata.name,
      guard: procedure.guard?.manifest.metadata.name,
    })),
    triggers: linked.triggers.map((trigger) => ({
      name: trigger.manifest.metadata.name,
      target: trigger.target.manifest.metadata.name,
      lifecycleSchema: trigger.lifecycleSchema?.manifest.metadata.name,
    })),
  };
}
