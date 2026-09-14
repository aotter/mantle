import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_OPS,
  DIAGNOSTIC_CODES,
  FILTER_COMPARISON_OPS,
  LIFECYCLE_HOOKS,
  MANTLE_BIND_VALUES,
  RESERVED_ENTRY_COLUMNS,
  RESERVED_MCP_GENERIC_TOOL_NAMES,
  RESERVED_MCP_TOOL_PREFIXES,
  STAFF_ROLES,
  VIEW_PARAMS_RESERVED,
  parseManifestSources,
  ValidateManifestsUseCase,
} from "../src/index.js";

/**
 * The handbook under `docs/handbook/` is the user-facing documentation that
 * ships in the `@aotter/mantle` tarball. These checks keep it from drifting
 * away from the grammar it describes:
 *
 * 1. every value of a closed catalog appears in the reference pages;
 * 2. every complete Manifest example parses and passes atom-local
 *    validation, and every `examples/` page also links cleanly;
 * 3. `navigation.json` and the page set agree, and relative links resolve.
 *
 * Presence checks only catch omissions. Executing the examples is what
 * exercises the rules themselves, so keep examples complete and current.
 */

const HANDBOOK = fileURLToPath(new URL("../../../docs/handbook/", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".md")) out.push(path);
  }
  return out.sort();
}

const pages = walk(HANDBOOK).map((path) => ({
  path,
  rel: relative(HANDBOOK, path),
  text: readFileSync(path, "utf8"),
}));

const referenceText = pages
  .filter((p) => p.rel.startsWith("reference/"))
  .map((p) => p.text)
  .join("\n");

/** Strip fenced code so prose checks do not match YAML comments or code. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

describe("handbook: closed catalogs are documented", () => {
  const list = (values: unknown): string[] =>
    values instanceof Set ? [...values].map(String) : Array.isArray(values) ? values.map(String) : Object.keys(values as object);
  const catalogs: Array<[string, string[]]> = [
    ["DIAGNOSTIC_CODES", list(DIAGNOSTIC_CODES)],
    ["BUILTIN_OPS", list(BUILTIN_OPS)],
    ["LIFECYCLE_HOOKS", list(LIFECYCLE_HOOKS)],
    ["MANTLE_BIND_VALUES", list(MANTLE_BIND_VALUES)],
    ["FILTER_COMPARISON_OPS", list(FILTER_COMPARISON_OPS)],
    ["STAFF_ROLES", list(STAFF_ROLES)],
    ["RESERVED_MCP_GENERIC_TOOL_NAMES", list(RESERVED_MCP_GENERIC_TOOL_NAMES)],
    ["RESERVED_MCP_TOOL_PREFIXES", list(RESERVED_MCP_TOOL_PREFIXES)],
    ["VIEW_PARAMS_RESERVED", list(VIEW_PARAMS_RESERVED)],
    ["RESERVED_ENTRY_COLUMNS", list(RESERVED_ENTRY_COLUMNS)],
  ];

  for (const [name, values] of catalogs) {
    it(`every ${name} value appears in reference/`, () => {
      const missing = values.filter((value) => !referenceText.includes(`\`${value}\``) && !referenceText.includes(value));
      expect(missing, `${name} values missing from docs/handbook/reference: ${missing.join(", ")}`).toEqual([]);
    });
  }
});

describe("handbook: Manifest examples parse and validate", () => {
  const LINK_CODES = new Set([
    "TRIGGER_TARGET_PROCEDURE_UNKNOWN",
    "LIFECYCLE_SCHEMA_UNKNOWN",
    "VIEW_FROM_UNKNOWN_SCHEMA",
    "BUILTIN_HANDLER_SCHEMA_UNKNOWN",
    "TRANSLATES_PARENT_UNKNOWN",
    "GUARD_PROCEDURE_UNKNOWN",
    "TRANSLATES_FIELD_NOT_IN_PARENT",
  ]);
  const siteLocales = ["en", "zh-TW"];

  for (const page of pages) {
    const blocks: string[] = [];
    for (const match of page.text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      const body = match[1] ?? "";
      if (!/^\s*(#.*\n)*apiVersion:/.test(body)) continue; // fragment, not a document
      if (/^kind:\s.*\|/m.test(body)) continue; // envelope illustration listing the kind enum
      blocks.push(body.trim());
    }
    if (blocks.length === 0) continue;

    const mustLink = page.rel.startsWith("examples/");
    it(`${page.rel} (${blocks.length} manifest block${blocks.length === 1 ? "" : "s"}${mustLink ? ", must link" : ""})`, () => {
      const parsed = parseManifestSources({ sources: [{ sourceId: page.rel, text: blocks.join("\n---\n") }] });
      if (!parsed.ok) {
        expect.fail(parsed.diagnostics.map((d) => `${d.code} ${d.path ?? ""}: ${d.message}`).join("\n"));
      }
      const result = ValidateManifestsUseCase.run({ parsed: parsed.value, siteLocales });
      const errors = result.diagnostics.filter(
        (d) => d.severity !== "warning" && (mustLink || !LINK_CODES.has(d.code)),
      );
      expect(errors.map((d) => `${d.code} ${d.path ?? ""}: ${d.message}`)).toEqual([]);
    });
  }
});

describe("handbook: navigation and links", () => {
  const navigation = JSON.parse(readFileSync(join(HANDBOOK, "navigation.json"), "utf8")) as {
    groups: Array<{ text: string; items: Array<{ text: string; link: string }> }>;
  };
  const navLinks = navigation.groups.flatMap((g) => g.items.map((i) => i.link));
  const pageLinks = pages.map((p) => "/" + p.rel.replace(/\.md$/, ""));

  it("every navigation link points at an existing page", () => {
    expect(navLinks.filter((l) => !pageLinks.includes(l))).toEqual([]);
  });

  it("every page is listed in navigation.json", () => {
    expect(pageLinks.filter((l) => !navLinks.includes(l))).toEqual([]);
  });

  it("every page has frontmatter, one H1 and a Source section", () => {
    const problems: string[] = [];
    for (const page of pages) {
      const body = prose(page.text);
      if (!page.text.startsWith("---\ndescription:")) problems.push(`${page.rel}: missing description frontmatter`);
      const h1 = body.split("\n").filter((l) => l.startsWith("# ")).length;
      if (h1 !== 1) problems.push(`${page.rel}: ${h1} H1 headings`);
      if (!/\n## Source\n/.test(page.text)) problems.push(`${page.rel}: missing ## Source`);
      if (/^::: /m.test(body)) problems.push(`${page.rel}: VitePress container (renders as junk outside the site)`);
    }
    expect(problems).toEqual([]);
  });

  it("every relative link resolves inside the repository", () => {
    const broken: string[] = [];
    for (const page of pages) {
      for (const match of prose(page.text).matchAll(/\]\((\.[^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = resolve(dirname(page.path), match[1] ?? "");
        try {
          statSync(target);
        } catch {
          broken.push(`${page.rel}: ${match[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
