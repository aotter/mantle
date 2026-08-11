import type { ContentState, Entry } from "@aotter/mantle-spec";

/**
 * `EntryRow` — DB row shape for `entries`. Mirrors the canonical
 * schema the runtime's migration list creates.
 *
 * `data` is the per-entry JSON blob authored against the Schema's
 * `spec.schema`. `version` is OCC; bumps on every persisted update.
 *
 * Per ADR-0010 the table has no `locale` column — locale lives at
 * `data.locale` (json_extract) so the lookup is uniform with every
 * other Schema-property field. `EntryRow.locale?` is a hydrated
 * convenience: every repository impl lifts `data.locale` onto the
 * top-level field at read time so renderers, path resolvers, and MCP
 * `get_entry` clients can branch on `row.locale`
 * without drilling into `data`. Mirrors spec `Entry`'s `locale?`
 * field for the same reason. The DB column shape stays unchanged;
 * this is purely a read-side projection.
 */
export interface EntryRow {
  readonly id: string;
  readonly collection: string;
  /** Lifted from `data.locale` at read time (ADR-0010). `undefined`
   *  when the Schema is not localized or the entry doesn't carry a
   *  locale. */
  readonly locale?: string;
  readonly status: ContentState;
  readonly version: number;
  readonly data: Record<string, unknown>;
  readonly authorId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Lift `data.locale` to the top-level `locale?` field. Centralised so
 * every repository impl (DatabaseDriver-backed, in-memory test fake,
 * future adapters) derives the convenience field the same way —
 * adding a per-impl hydration helper would let them drift.
 */
export function liftLocale(
  data: Record<string, unknown>,
): string | undefined {
  const v = data["locale"];
  return typeof v === "string" ? v : undefined;
}

/** Explicit public projection. Keep this field-by-field so adding another
 * persistence-only property to `EntryRow` cannot silently expose it. */
export function projectPublicEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    collection: row.collection,
    locale: row.locale,
    status: row.status,
    version: row.version,
    data: row.data,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class EntryVersionConflict extends Error {
  constructor(
    public readonly id: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`version conflict on ${id}: expected ${expected}, found ${actual}`);
    this.name = "EntryVersionConflict";
  }
}

/**
 * Thrown by `transitionStatus({ expectedStatus })` when the row's
 * current status doesn't match. Distinct from version conflict
 * because it carries `ContentState` instead of numeric version, so
 * the orchestration layer can emit a tailored CONFLICT diagnostic
 * (e.g. "expected 'draft', found 'published'").
 */
export class EntryStatusConflict extends Error {
  constructor(
    public readonly id: string,
    public readonly expected: ContentState,
    public readonly actual: ContentState,
  ) {
    super(`status conflict on ${id}: expected ${expected}, found ${actual}`);
    this.name = "EntryStatusConflict";
  }
}
