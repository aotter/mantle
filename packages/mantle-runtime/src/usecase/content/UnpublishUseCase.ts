import {
  canTransition,
  DiagnosticError,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { Clock } from "../../domain/port/Clock.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { UnpublishRequest } from "../dto/content/index.js";
import {
  illegalTransitionDiagnostic,
  notFoundDiagnostic,
  withConflictDiagnostic,
} from "./diagnostics.js";

/**
 * `UnpublishUseCase` — flip published / archived rows back to
 * `'draft'`. Used by the admin SPA's "edit a published entry" flow.
 */
export class UnpublishUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly clock: Clock,
  ) {}

  async execute(request: UnpublishRequest): Promise<EntryRow> {
    const opPath = `usecase/Unpublish/${request.id}`;
    const existing = await this.entries.get(request.id);
    if (!existing) {
      throw new DiagnosticError(notFoundDiagnostic(opPath, "<unknown>", request.id));
    }
    const schema = this.schemas.get(existing.collection);
    if (!canTransition(schema, existing.status, "draft")) {
      throw new DiagnosticError(
        illegalTransitionDiagnostic(opPath, existing.status, "draft"),
      );
    }
    const unpublished = await withConflictDiagnostic(opPath, () =>
      this.entries.transitionStatus({
        id: request.id,
        collection: existing.collection,
        to: "draft",
        expectedStatus: existing.status,
        // Pin the version we read above — a concurrent mutation between
        // get() and the flip must fail rather than silently unpublish a
        // row whose state has moved on. Matches RequestPublishUseCase.
        expectedVersion: existing.version,
        now: this.clock.now(),
        hookContext: request.ctx,
        originalInput: request.originalInput,
      }),
    );
    return unpublished;
  }
}
