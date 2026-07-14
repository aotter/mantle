import {
  canTransition,
  DiagnosticError,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { Clock } from "../../domain/port/Clock.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { ArchiveRequest } from "../dto/content/index.js";
import {
  unpublishCache,
  type ContentPublishEffects,
} from "./ContentPublishEffects.js";
import {
  illegalTransitionDiagnostic,
  notFoundDiagnostic,
  withConflictDiagnostic,
} from "./diagnostics.js";

/**
 * `ArchiveUseCase` — flip an entry to `'archived'`. Per the simple-
 * lifecycle state machine, draft and published rows can both be
 * archived; archived rows go back to draft via `Unpublish`.
 */
export class ArchiveUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly clock: Clock,
    private readonly effects?: ContentPublishEffects,
  ) {}

  async execute(request: ArchiveRequest): Promise<EntryRow> {
    const opPath = `usecase/Archive/${request.id}`;
    const existing = await this.entries.get(request.id);
    if (!existing) {
      throw new DiagnosticError(notFoundDiagnostic(opPath, "<unknown>", request.id));
    }
    const schema = this.schemas.get(existing.collection);
    if (!canTransition(schema, existing.status, "archived")) {
      throw new DiagnosticError(
        illegalTransitionDiagnostic(opPath, existing.status, "archived"),
      );
    }
    // Pin OCC to the version we just fetched so the guard above and
    // the chokepoint assertion see the same snapshot.
    const archived = await withConflictDiagnostic(opPath, () =>
      this.entries.transitionStatus({
        id: request.id,
        collection: existing.collection,
        to: "archived",
        expectedVersion: existing.version,
        now: this.clock.now(),
        hookContext: request.ctx,
        originalInput: request.originalInput,
      }),
    );
    await unpublishCache(this.effects, archived.id);
    return archived;
  }
}
