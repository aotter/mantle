import {
  DiagnosticError,
  checkSchemaAdminUi,
  runtimeDiagnostic,
  schemaSortableFields,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { ListEntriesResult } from "../../domain/port/EntryRepository.js";
import { clampLimit } from "../../domain/service/Pagination.js";
import type {
  ListEntriesRequest,
} from "../dto/content/index.js";
import {
  schemaUnknownDiagnostic,
  sortFieldUnavailableDiagnostic,
} from "./diagnostics.js";

/**
 * `ListEntriesUseCase` — list entries in a collection, optionally
 * filtered by status. Asserts the collection is a declared Schema.
 *
 * Two methods, two audiences:
 *
 *  - `execute(req): readonly EntryRow[]` — what app code wants. A flat
 *    array, ready for `.find(...)` / `.filter(...)` / `.map(...)`. No
 *    pagination wrapper to unwrap. Returns one clamped page; if the
 *    collection has more rows than `limit`, they're silently dropped
 *    — agent authors who care about that reach for `executePage`.
 *
 *  - `executePage(req): ListEntriesResult` — what
 *    cursor-aware callers (MCP `list_entries`, admin pagination,
 *    long-tail walkers) want. Returns `{ rows, nextCursor? }`.
 *
 * Why split: the Mantle thesis says the runtime should carry complexity
 * away from authors. Asking a starter author to write
 * `runtime.listEntries.execute(...).rows.find(...)` for the 99% case
 * (small collection, single page is enough) is the runtime pushing
 * cursor-walking concerns into authoring code. Two methods is one
 * extra symbol on the use case — paid by the runtime, not the author.
 *
 * Caller-supplied `limit` is clamped at this layer (the trust
 * boundary between MCP / admin transports and the chokepoint
 * `EntryRepository`). Cursor is round-tripped opaquely.
 */
export class ListEntriesUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
  ) {}

  async execute(request: ListEntriesRequest): Promise<readonly EntryRow[]> {
    const page = await this.executePage(request);
    return page.rows;
  }

  async executePage(
    request: ListEntriesRequest,
  ): Promise<ListEntriesResult> {
    const opPath = `usecase/ListEntries/${request.collection}`;
    const schema = this.schemas.get(request.collection);
    if (!schema) {
      throw new DiagnosticError(
        schemaUnknownDiagnostic(opPath, request.collection, [...this.schemas.keys()]),
      );
    }
    if (request.sort && !isSortableField(schema, request.sort.field)) {
      throw new DiagnosticError(sortFieldUnavailableDiagnostic(opPath, request.sort.field));
    }
    const listFilter = checkSchemaAdminUi(schema).filter;
    if (request.filter && !(
      listFilter?.field === request.filter.field && listFilter.values.includes(request.filter.value)
    )) {
      throw new DiagnosticError(filterUnavailableDiagnostic(opPath, request.filter));
    }
    return this.entries.list({
      collection: request.collection,
      status: request.status,
      limit: clampLimit(request.limit),
      cursor: request.cursor,
      cursorDirection: request.cursorDirection,
      search: request.search,
      searchFields: schema.spec.searchableFields ?? [],
      filter: request.filter,
      sort: request.sort,
    });
  }
}

function filterUnavailableDiagnostic(
  path: string,
  filter: NonNullable<ListEntriesRequest["filter"]>,
) {
  return runtimeDiagnostic({
    code: "INPUT_VALIDATION_FAILED",
    severity: "error",
    path: `${path}/filter`,
    value: filter,
    expected: "an indexed string-enum field and one of its declared values",
    message: `Filter '${filter.field}=${filter.value}' is not available.`,
  });
}

function isSortableField(schema: SchemaManifest, field: string): boolean {
  if (field === "id" || field === "status" || field === "updatedAt") return true;
  return schemaSortableFields(schema).includes(field);
}
