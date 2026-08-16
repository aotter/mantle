import type { SchemaManifest } from "../model/ManifestGrammar.js";
import {
  bestMatch,
  manifestPath,
  type ManifestFilePaths,
} from "./ManifestPathDiagnoser.js";
import { canonicalizeLocaleList } from "./LocaleCanonicalizer.js";
import {
  bootDiagnostic,
  validateDiagnostic,
  type Diagnostic,
  type Phase,
} from "../../kernel/diagnostic.js";

/**
 * Cross-Schema checks for the locale + translates grammar additions
 * introduced in ADR-0010. Runs in both the validate phase (CLI,
 * pre-deploy) and the boot phase (Worker init, post-deploy). The
 * static parts (parent existence, join-field membership in both
 * Schemas, translates-implies-localized) don't need any environment.
 * The site-locales check needs the runtime config, so it runs only
 * when `siteLocales` is provided.
 *
 * Caller passes the phase tag so diagnostics surface as
 * `validate/<code>` or `boot/<code>` per ADR-0008.
 */
export interface CrossSchemaCheckInput {
  readonly schemas: ReadonlyArray<SchemaManifest>;
  readonly phase: Extract<Phase, "validate" | "boot">;
  /** Site config locales (ordered, first is canonical). When absent,
   *  the SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES check is skipped —
   *  validate-from-CLI flows can't reach the runtime DB to read this.
   *  Boot always has access and should pass it. */
  readonly siteLocales?: ReadonlyArray<string>;
  /** Optional file-path index for nicer diagnostic paths in the
   *  validate phase. See {@link ManifestFilePaths}. */
  readonly filePaths?: ManifestFilePaths;
}

/** Compatibility composition; production stages call their single owned check. */
export function checkLocaleAndTranslates(input: CrossSchemaCheckInput): Diagnostic[] {
  return [
    ...checkSiteLocales(input),
    ...checkTranslatesReferences(input.schemas, input.phase, input.filePaths),
  ];
}

/** Deployment-dependent locale availability; parse/link never call this. */
export function checkSiteLocales(input: CrossSchemaCheckInput): Diagnostic[] {
  const { schemas, phase, siteLocales, filePaths } = input;
  const out: Diagnostic[] = [];
  const siteLocalesGiven = siteLocales !== undefined;

  // Canonicalize the site locales the caller passed before any
  // schema-vs-locales check uses them.
  let validSiteLocalesCount = siteLocalesGiven ? siteLocales.length : 0;
  if (siteLocalesGiven && siteLocales.length > 0) {
    const { valid, invalid } = canonicalizeLocaleList(siteLocales);
    validSiteLocalesCount = valid.length;
    if (invalid.length > 0) {
      out.push(
        emit(phase, {
          code: "INVALID_LOCALE",
          severity: "error",
          path: "site_config/locales",
          value: invalid,
          expected: "Mantle v0.1 locale tags (e.g. 'en' or 'zh-TW', case-insensitive; script subtags are unsupported)",
          message: `site_config.locales contains invalid entries: ${invalid.map((s) => `'${s}'`).join(", ")}. Use language plus optional 2-letter region (for example 'zh-TW', not 'zh-Hant') and fix via the Settings page or DB directly.`,
        }),
      );
    }
  }
  const siteLocalesEmpty = siteLocalesGiven && validSiteLocalesCount === 0;

  for (const s of schemas) {
    const path = (jsonPointer: string) =>
      manifestPath("Schema", s.metadata.name, jsonPointer, filePaths);

    if (s.spec.localized === true && siteLocalesGiven && siteLocalesEmpty) {
      out.push(
        emit(phase, {
          code: "SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES",
          severity: "error",
          path: path("/spec/localized"),
          value: true,
          expected: "site_config.locales to declare at least one BCP 47 locale before any Schema can be localized",
          message: `Schema '${s.metadata.name}' is localized but the site has no locales configured. Set site_config.locales (e.g. ['en'] or ['zh-TW']) or remove localized: true.`,
        }),
      );
    }
  }

  return out;
}

/** Cross-Schema translation references. Atom-local translation shape lives in the parser. */
export function checkTranslatesReferences(
  schemas: readonly SchemaManifest[],
  phase: Extract<Phase, "validate" | "boot">,
  filePaths?: ManifestFilePaths,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const schemasByName = new Map(schemas.map((schema) => [schema.metadata.name, schema]));
  for (const s of schemas) {
    const translates = s.spec.translates;
    if (!translates) continue;
    const path = (jsonPointer: string) =>
      manifestPath("Schema", s.metadata.name, jsonPointer, filePaths);
    const parent = schemasByName.get(translates.parent);
    if (!parent) {
      out.push(
        emit(phase, {
          code: "TRANSLATES_PARENT_UNKNOWN",
          severity: "error",
          path: path("/spec/translates/parent"),
          value: translates.parent,
          expected: "name of a declared Schema",
          candidates: [...schemasByName.keys()],
          suggestion: bestMatch(translates.parent, [...schemasByName.keys()]),
          message: `Schema '${s.metadata.name}' translates.parent references unknown Schema '${translates.parent}'.`,
        }),
      );
      continue;
    }
    if (parent.spec.localized === true) {
      out.push(
        emit(phase, {
          code: "TRANSLATES_PARENT_IS_LOCALIZED",
          severity: "error",
          path: path("/spec/translates/parent"),
          value: translates.parent,
          expected: "parent Schema must NOT be localized (it carries the non-translatable facts; translation rows are this Schema)",
          message: `Schema '${s.metadata.name}' translates.parent '${translates.parent}' is itself localized. The parent should hold non-translatable facts (e.g. sku, price); the localized child holds the translatable fields.`,
        }),
      );
    }
    const parentProps = propertyKeys(parent);
    if (!parentProps.has(translates.on)) {
      out.push(
        emit(phase, {
          code: "TRANSLATES_FIELD_NOT_IN_PARENT",
          severity: "error",
          path: path("/spec/translates/on"),
          value: translates.on,
          expected: `field declared in Schema '${parent.metadata.name}' spec.schema.properties`,
          candidates: [...parentProps].sort(),
          suggestion: bestMatch(translates.on, [...parentProps]),
          message: `Schema '${s.metadata.name}' translates.on field '${translates.on}' is not declared on parent Schema '${parent.metadata.name}'.`,
        }),
      );
    }
  }
  return out;
}

function emit(
  phase: Extract<Phase, "validate" | "boot">,
  payload: Parameters<typeof validateDiagnostic>[0],
): Diagnostic {
  return phase === "validate" ? validateDiagnostic(payload) : bootDiagnostic(payload);
}

function propertyKeys(s: SchemaManifest): Set<string> {
  const props = (s.spec.schema as { properties?: Record<string, unknown> }).properties ?? {};
  return new Set(Object.keys(props));
}
