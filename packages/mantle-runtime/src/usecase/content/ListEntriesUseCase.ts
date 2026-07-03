import {
  DiagnosticError,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import { clampLimit } from "../../domain/service/Pagination.js";
import type {
  ListEntriesRequest,
  ListEntriesResponse,
} from "../dto/content/index.js";
import { schemaUnknownDiagnostic } from "./diagnostics.js";

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
 *  - `executePage(req): ListEntriesResponse<EntryRow>` — what
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
  ): Promise<ListEntriesResponse<EntryRow>> {
    const opPath = `usecase/ListEntries/${request.collection}`;
    if (!this.schemas.has(request.collection)) {
      throw new DiagnosticError(
        schemaUnknownDiagnostic(opPath, request.collection, [...this.schemas.keys()]),
      );
    }
    // `ListEntriesResult` is structurally identical to
    // `ListEntriesResponse<EntryRow>` — pass it through rather than
    // re-spreading field-by-field.
    return this.entries.list({
      collection: request.collection,
      status: request.status,
      limit: clampLimit(request.limit),
      cursor: request.cursor,
      search: request.search,
    });
  }
}
