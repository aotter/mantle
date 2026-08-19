import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVISION_LIMITS,
  PROVISION_BUNDLE_KIND,
  ProvisionRenderError,
  renderProvisionBundle,
  safeTarget,
  type LaunchValues,
  type ProvisionBundle,
  type ProvisionErrorCode,
} from "../src/provision.js";

// One golden bundle exercising text, template, binary, localized, manifest,
// and wrangler paths. Failure cases mutate a copy of it.
const GOLDEN: ProvisionBundle = {
  kind: PROVISION_BUNDLE_KIND,
  version: "0.1.0-alpha.7",
  archetype: "intake",
  files: {
    "README.md": "# {{BRAND}}\n\n{{DESCRIPTION}}\n",
    "wrangler.toml": [
      'name = "mantle-intake"',
      'main = "src/index.ts"',
      "",
      "[vars]",
      'PUBLIC_ORIGIN = "http://localhost:8787"',
      'MANTLE_AUTH_MODE = "{{AUTH_MODE}}"',
      "",
      "[[d1_databases]]",
      'binding = "DB"',
      'database_name = "mantle-intake-local"',
      "",
    ].join("\n"),
    ".mantle/launch-state.json.template": '{\n  "project_name": "{{PROJECT_NAME}}",\n  "brand": "{{BRAND}}",\n  "locales": {{LOCALES}}\n}\n',
    ".mantle/overlays/intake/seed.json": '{"locales":{"en":{"title":"Requests"},"ja":{"title":"リクエスト"},"zh-TW":{"title":"申請"}}}',
    "manifests/site.yaml": [
      "apiVersion: cms.mantle.aotter.net/v1",
      "kind: Schema",
      "metadata:",
      "  name: request",
      "spec:",
      "  title:",
      "    en: Request",
      "    ja: リクエスト",
      "    zh-TW: 申請",
      "",
    ].join("\n"),
    "public/robots.txt": "User-agent: *\n",
  },
  binaryFiles: { "public/site-icon.png": "aGVsbG8=" },
  localizedFiles: [".mantle/overlays/intake/seed.json"],
};

const LAUNCH: LaunchValues = {
  archetype: "intake",
  projectName: "morning-lab",
  brand: 'Morning "Lab"',
  description: "Equipment requests.\\nSecond line.",
  locales: ["en", "ja"],
  canonicalLocale: "en",
  authMode: "self-managed",
  starterRef: "v0.1.0-alpha.7",
  installTimestamp: "2026-08-19T00:00:00.000Z",
};

const clone = (bundle: ProvisionBundle): ProvisionBundle =>
  JSON.parse(JSON.stringify(bundle)) as ProvisionBundle;

function expectFailure(
  code: ProvisionErrorCode,
  bundle: ProvisionBundle,
  launch: LaunchValues = LAUNCH,
): void {
  try {
    renderProvisionBundle({ bundle, launch });
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisionRenderError);
    expect((error as ProvisionRenderError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("renderProvisionBundle — golden bundle", () => {
  const rendered = renderProvisionBundle({ bundle: GOLDEN, launch: LAUNCH });

  it("substitutes placeholders and strips the .template suffix", () => {
    expect(rendered.files.get("README.md")).toBe('# Morning "Lab"\n\nEquipment requests.\\nSecond line.\n');
    expect(rendered.files.has(".mantle/launch-state.json.template")).toBe(false);
    const launchState = JSON.parse(rendered.files.get(".mantle/launch-state.json") as string);
    expect(launchState).toEqual({
      project_name: "morning-lab",
      brand: 'Morning "Lab"',
      locales: ["en", "ja"],
    });
  });

  it("keeps binary files as canonical base64 without substitution", () => {
    expect(rendered.binaryFiles.get("public/site-icon.png")).toBe("aGVsbG8=");
    expect(rendered.files.has("public/site-icon.png")).toBe(false);
  });

  it("selects only the requested locale catalogs", () => {
    const seed = JSON.parse(rendered.files.get(".mantle/overlays/intake/seed.json") as string);
    expect(Object.keys(seed.locales)).toEqual(["en", "ja"]);
  });

  it("trims manifest localized text to the requested locales", () => {
    const manifest = rendered.files.get("manifests/site.yaml") as string;
    expect(manifest).toContain("en: Request");
    expect(manifest).toContain("ja: ");
    expect(manifest).not.toContain("zh-TW");
  });

  it("rewrites the wrangler project and database name only", () => {
    const wrangler = rendered.files.get("wrangler.toml") as string;
    expect(wrangler).toContain('name = "morning-lab"');
    expect(wrangler).toContain('database_name = "morning-lab-db"');
    expect(wrangler).toContain('MANTLE_AUTH_MODE = "self-managed"');
    expect(wrangler).toContain('main = "src/index.ts"');
  });

  it("upserts host-supplied wrangler vars without touching the rest", () => {
    const withVars = renderProvisionBundle({
      bundle: GOLDEN,
      launch: { ...LAUNCH, wranglerVars: { PUBLIC_ORIGIN: "https://example.com", TURNSTILE_SITE_KEY: "abc" } },
    });
    const wrangler = withVars.files.get("wrangler.toml") as string;
    expect(wrangler).toContain('PUBLIC_ORIGIN = "https://example.com"');
    expect(wrangler).toContain('TURNSTILE_SITE_KEY = "abc"');
    expect(wrangler).not.toContain("http://localhost:8787");
  });

  it("is deterministic for one input set", () => {
    const again = renderProvisionBundle({ bundle: GOLDEN, launch: LAUNCH });
    expect([...again.files]).toEqual([...rendered.files]);
    expect([...again.binaryFiles]).toEqual([...rendered.binaryFiles]);
  });
});

describe("renderProvisionBundle — bundle failures", () => {
  it("rejects a foreign bundle kind", () => {
    expectFailure("bundle_kind_mismatch", { ...clone(GOLDEN), kind: "something-else" });
  });

  it("rejects an archetype that does not match the request", () => {
    expectFailure("bundle_archetype_mismatch", { ...clone(GOLDEN), archetype: "presence" });
  });

  it("rejects non-canonical base64", () => {
    const bundle = clone(GOLDEN);
    (bundle.binaryFiles as Record<string, string>)["public/site-icon.png"] = "aGVsbG8";
    expectFailure("binary_invalid", bundle);
  });

  it("rejects a bundle over the file limit", () => {
    const bundle = clone(GOLDEN);
    try {
      renderProvisionBundle({
        bundle,
        launch: LAUNCH,
        limits: { ...DEFAULT_PROVISION_LIMITS, maxFiles: 1 },
      });
    } catch (error) {
      expect((error as ProvisionRenderError).code).toBe("bundle_too_large");
      return;
    }
    throw new Error("expected bundle_too_large");
  });

  it("rejects an oversized decoded binary", () => {
    const bundle = clone(GOLDEN);
    try {
      renderProvisionBundle({
        bundle,
        launch: LAUNCH,
        limits: { ...DEFAULT_PROVISION_LIMITS, maxDecodedBinaryBytes: 1 },
      });
    } catch (error) {
      expect((error as ProvisionRenderError).code).toBe("bundle_too_large");
      return;
    }
    throw new Error("expected bundle_too_large");
  });

  it("rejects localizedFiles that reference a missing file", () => {
    const bundle = clone(GOLDEN);
    (bundle as { localizedFiles: string[] }).localizedFiles = ["nope.json"];
    expectFailure("bundle_invalid", bundle);
  });
});

describe("renderProvisionBundle — path safety", () => {
  const withPath = (path: string): ProvisionBundle => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)[path] = "x";
    return bundle;
  };

  it.each([
    ["/etc/passwd"],
    ["../escape.txt"],
    ["a/../../escape.txt"],
    ["C:/windows/system32"],
    ["\\\\server\\share"],
    ["nested//empty.txt"],
    ["./dot.txt"],
  ])("rejects %s", (path) => {
    expectFailure("path_unsafe", withPath(path));
  });

  it("rejects a NUL byte in a path", () => {
    expectFailure("path_unsafe", withPath("bad\u0000name.txt"));
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(safeTarget("src\\worker\\index.ts")).toBe("src/worker/index.ts");
  });

  it("strips only a trailing .template suffix", () => {
    expect(safeTarget("a/b.json.template")).toBe("a/b.json");
    expect(safeTarget("a/template.json")).toBe("a/template.json");
  });

  it("rejects two paths that collide after normalization", () => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)["docs\\guide.md"] = "a";
    (bundle.files as Record<string, string>)["docs/guide.md"] = "b";
    expectFailure("path_collision", bundle);
  });

  it("rejects a case-folded collision", () => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)["Readme.md"] = "duplicate";
    expectFailure("path_collision", bundle);
  });

  it("rejects a text file that overlaps a binary file", () => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)["public/site-icon.png"] = "not binary";
    expectFailure("path_collision", bundle);
  });

  it("rejects a template suffix that collides with its rendered target", () => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)["README.md.template"] = "duplicate";
    expectFailure("path_collision", bundle);
  });
});

describe("renderProvisionBundle — placeholders and launch values", () => {
  it("rejects an unknown placeholder", () => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)["README.md"] = "{{NOT_A_PLACEHOLDER}}";
    expectFailure("placeholder_unknown", bundle);
  });

  it("rejects a placeholder in a file type that is never substituted", () => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)["public/logo.svg"] = "<title>{{BRAND}}</title>";
    expectFailure("placeholder_unresolved", bundle);
  });

  it("escapes values embedded in JSON string literals", () => {
    const rendered = renderProvisionBundle({ bundle: GOLDEN, launch: LAUNCH });
    // Parsing proves the quotes in the brand did not break the literal.
    expect(JSON.parse(rendered.files.get(".mantle/launch-state.json") as string).brand).toBe('Morning "Lab"');
  });

  it.each([
    ["Morning Lab", "projectName is not a slug"],
    ["-leading-dash", "projectName starts with a dash"],
    ["a".repeat(64), "projectName is too long"],
  ])("rejects %s", (projectName) => {
    expectFailure("launch_value_invalid", GOLDEN, { ...LAUNCH, projectName });
  });

  it("rejects a canonical locale outside the selected locales", () => {
    expectFailure("launch_value_invalid", GOLDEN, { ...LAUNCH, canonicalLocale: "fr" });
  });

  it("rejects a duplicate locale", () => {
    expectFailure("launch_value_invalid", GOLDEN, { ...LAUNCH, locales: ["en", "en"] });
  });

  it("rejects a malformed locale", () => {
    expectFailure("launch_value_invalid", GOLDEN, { ...LAUNCH, locales: ["en", "english"] });
  });

  it("rejects a non-ISO install timestamp", () => {
    expectFailure("launch_value_invalid", GOLDEN, { ...LAUNCH, installTimestamp: "yesterday" });
  });

  it("rejects control characters in a brand", () => {
    expectFailure("launch_value_invalid", GOLDEN, { ...LAUNCH, brand: "Morning\u0000Lab" });
  });
});

describe("renderProvisionBundle — locales", () => {
  it("rejects a locale the catalog does not carry", () => {
    expectFailure("locale_unsupported", GOLDEN, { ...LAUNCH, locales: ["en", "fr"] });
  });

  it("rejects a localized file that is not JSON", () => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)[".mantle/overlays/intake/seed.json"] = "not json";
    expectFailure("locale_catalog_invalid", bundle);
  });

  it("rejects a localized file with no locale catalog", () => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)[".mantle/overlays/intake/seed.json"] = '{"other":1}';
    expectFailure("locale_catalog_invalid", bundle);
  });

  it("rejects a non-blank archetype with no localized seed asking for a second locale", () => {
    const bundle = clone(GOLDEN);
    delete (bundle as { localizedFiles?: unknown }).localizedFiles;
    expectFailure("locale_unsupported", bundle, { ...LAUNCH, locales: ["en", "ja"] });
  });

  it("rejects invalid manifest YAML", () => {
    const bundle = clone(GOLDEN);
    (bundle.files as Record<string, string>)["manifests/site.yaml"] = "a:\n  - [unclosed\n";
    expectFailure("manifest_invalid", bundle);
  });
});
