import {
  DiagnosticError,
  EntryDataValidator,
  MANTLE_BIND_KEYWORD,
  runtimeDiagnostic,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRepository } from "../../port/EntryRepository.js";
import type { SiteConfigRepository } from "../../port/SiteConfigRepository.js";

export interface AssertEntryWritableArgs {
  readonly opPath: string;
  readonly entries: EntryRepository;
  readonly schema: SchemaManifest;
  readonly data: Record<string, unknown>;
  readonly excludeId?: string;
  readonly siteConfig?: SiteConfigRepository;
  /** Draft mode: skip required-field + locale-presence checks so a
   *  work-in-progress entry can be saved incomplete. Publish paths
   *  omit this, so completeness is enforced before an entry goes live. */
  readonly partial?: boolean;
}

/** Shared post-projection guard for every authoring path.
 *
 * MCP, admin/API, and builtin Procedure writes all land here after
 * `x-mantle-bind` stamping, so schema validation and unique-index
 * semantics cannot drift by transport.
 */
export async function assertEntryWritable(args: AssertEntryWritableArgs): Promise<void> {
  const validator = new EntryDataValidator();
  const diagnostics = validator.validate(args.schema, dataForValidation(args.schema, args.data), {
    partial: args.partial ?? false,
  });
  if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);
  await assertLocale(args);
  await assertUniqueIndexes(args);
}

async function assertLocale(args: AssertEntryWritableArgs): Promise<void> {
  const localized = args.schema.spec.localized === true;
  const value = args.data["locale"];
  if (!localized) {
    if (value === undefined || value === null) return;
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "INPUT_VALIDATION_FAILED",
        severity: "error",
        path: `${args.opPath}/locale`,
        value,
        expected: `no data.locale because Schema '${args.schema.metadata.name}' is not localized`,
        message: `Entry for non-localized Schema '${args.schema.metadata.name}' must not carry data.locale.`,
      }),
    );
  }

  if (typeof value !== "string" || value.length === 0) {
    // Draft may not have picked a locale yet; publish re-checks.
    if (args.partial) return;
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "INPUT_VALIDATION_FAILED",
        severity: "error",
        path: `${args.opPath}/locale`,
        value,
        expected: "data.locale string",
        message: `Entry for localized Schema '${args.schema.metadata.name}' must carry data.locale.`,
      }),
    );
  }
  if (!args.siteConfig) return;
  const locales = await args.siteConfig.readLocales();
  // ADR-0010: empty `site_config.locales` means the locale subsystem
  // is off site-wide. Pass through so a fresh deploy whose `bootInit`
  // hasn't seeded locales yet can still accept localized writes.
  if (locales.length === 0) return;
  if (locales.includes(value)) return;
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "INPUT_VALIDATION_FAILED",
      severity: "error",
      path: `${args.opPath}/locale`,
      value,
      expected: `one of site.locales: ${locales.join(", ")}`,
      candidates: locales,
      message: `Locale '${value}' is not enabled for this site.`,
    }),
  );
}

function dataForValidation(
  schema: SchemaManifest,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const properties =
    (schema.spec.schema as { properties?: Record<string, unknown> }).properties ?? {};
  let out: Record<string, unknown> | null = null;
  for (const [key, propDef] of Object.entries(properties)) {
    if (!isMantleBindProperty(propDef) || data[key] !== null) continue;
    if (!out) out = { ...data };
    delete out[key];
  }
  return out ?? data;
}

function isMantleBindProperty(propDef: unknown): boolean {
  return typeof propDef === "object" && propDef !== null && MANTLE_BIND_KEYWORD in propDef;
}

async function assertUniqueIndexes(args: AssertEntryWritableArgs): Promise<void> {
  const indexes = args.schema.spec.uniqueIndexes ?? [];
  for (let i = 0; i < indexes.length; i += 1) {
    const index = indexes[i] ?? [];
    const fields: Record<string, unknown> = {};
    let complete = true;
    for (const field of index) {
      const value = args.data[field];
      if (value === undefined || value === null) {
        complete = false;
        break;
      }
      fields[field] = value;
    }
    if (!complete || Object.keys(fields).length === 0) continue;
    const existing = await args.entries.findByDataFields({
      collection: args.schema.metadata.name,
      fields,
      excludeId: args.excludeId,
    });
    if (!existing) continue;
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "CONFLICT",
        severity: "error",
        path: `${args.opPath}/uniqueIndexes/${i}`,
        value: fields,
        expected: `unique ${index.map((f) => `data.${f}`).join(" + ")} in collection '${args.schema.metadata.name}'`,
        message: `Entry data conflicts with existing '${args.schema.metadata.name}' entry '${existing.id}' on unique index (${index.join(", ")}).`,
      }),
    );
  }
}
