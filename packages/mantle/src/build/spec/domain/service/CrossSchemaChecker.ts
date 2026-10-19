import type { SchemaManifest } from "../model/ManifestGrammar.js";
import {
  bestMatch,
  manifestPath,
  type ManifestFilePaths,
} from "./ManifestPathDiagnoser.js";
import {
  bootDiagnostic,
  validateDiagnostic,
  type Diagnostic,
  type Phase,
} from "../../kernel/diagnostic.js";

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
    if (s.spec.ttl || parent.spec.ttl) {
      out.push(emit(phase, {
        code: "SCHEMA_TTL_TRANSLATION_UNSUPPORTED",
        severity: "error",
        path: path("/spec/translates"),
        message: `Schema '${s.metadata.name}' cannot translate TTL Schema '${parent.metadata.name}' or declare TTL itself; joined translations cannot guarantee expiry across both Schemas.`,
        expected: "TTL only on Schemas outside a translation relationship",
      }));
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
