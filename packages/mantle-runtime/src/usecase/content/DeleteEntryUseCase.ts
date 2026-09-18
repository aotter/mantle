import { DiagnosticError, type SchemaManifest } from "@aotter/mantle-spec";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import { assertEntryDeletable } from "../../domain/service/io/EntryDeleteGuard.js";
import type {
  DeleteEntryRequest,
  DeleteEntryResponse,
} from "../dto/content/index.js";
import { notFoundDiagnostic, withConflictDiagnostic } from "./diagnostics.js";

/**
 * `DeleteEntryUseCase` — permanently delete an entry. Distinct from
 * `Archive`: archive is a status flip, delete removes the row.
 *
 * We read the row first so missing ids surface as a structured
 * `NOT_FOUND` (matching every other content-op use case) instead of
 * a silent `{ removed: false }` — callers building UIs need the
 * diagnostic to distinguish "you deleted nothing" from "you tried to
 * delete a ghost."
 */
export class DeleteEntryUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
  ) {}

  async execute(request: DeleteEntryRequest): Promise<DeleteEntryResponse> {
    const opPath = `usecase/DeleteEntry/${request.id}`;
    const existing = await this.entries.get(request);
    if (!existing) {
      throw new DiagnosticError(
        notFoundDiagnostic(opPath, request.collection, request.id),
      );
    }
    assertEntryDeletable({
      entry: existing,
      schema: this.schemas.get(request.collection),
      expectedCollection: request.collection,
      opPath,
    });
    return withConflictDiagnostic(opPath, () =>
      this.entries.delete({
        id: request.id,
        collection: request.collection,
        expectedStatus: existing.status,
        expectedVersion: existing.version,
        hookContext: request.ctx,
        originalInput: request.originalInput,
      }),
    );
  }
}
