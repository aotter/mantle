import {
  DiagnosticError,
  resolveLifecycle,
  runtimeDiagnostic,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { Clock } from "../../domain/port/Clock.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";
import { projectUpdateAndStamp } from "../../domain/service/BuiltinProjector.js";
import type { UpdateDraftRequest } from "../dto/content/index.js";
import {
  notFoundDiagnostic,
  withConflictDiagnostic,
} from "./diagnostics.js";
import { assertEntryWritable } from "../../domain/service/io/EntryWriteGuard.js";

/**
 * `UpdateDraftUseCase` — update a draft's data. Only entries in
 * `'draft'` status are editable — `published` / `archived` go via the
 * unpublish (back to draft) path first.
 */
export class UpdateDraftUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly clock: Clock,
    private readonly siteConfig?: SiteConfigRepository,
  ) {}

  async execute(request: UpdateDraftRequest): Promise<EntryRow> {
    const opPath = `usecase/UpdateDraft/${request.id}`;
    const existing = await this.entries.get(request.id);
    if (!existing) {
      throw new DiagnosticError(notFoundDiagnostic(opPath, "<unknown>", request.id));
    }
    // lifecycle: none records have no draft/published workflow — they
    // are editable in place regardless of stored status.
    const lifecycle = resolveLifecycle(this.schemas.get(existing.collection));
    if (existing.status !== "draft" && lifecycle !== "none") {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "CONFLICT",
          severity: "error",
          path: opPath,
          value: existing.status,
          expected: "row.status === 'draft'",
          message: `Entry '${request.id}' is in status '${existing.status}'; only drafts are editable. Unpublish first.`,
        }),
      );
    }
    const schema = this.schemas.get(existing.collection);
    if (!schema) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BUILTIN_HANDLER_SCHEMA_UNKNOWN",
          severity: "error",
          path: `${opPath}#/collection`,
          value: existing.collection,
          expected: "name of a declared Schema",
          candidates: [...this.schemas.keys()],
          message: `Entry '${request.id}' belongs to unknown Schema '${existing.collection}'.`,
        }),
      );
    }
    const now = this.clock.now();
    const ctx = authoringContext(request.ctx, existing.authorId);
    const data = projectUpdateAndStamp({
      schema,
      existing: existing.data,
      patch: request.data,
      ctx,
      clockNow: now,
    });
    await assertEntryWritable({
      opPath,
      entries: this.entries,
      schema,
      data,
      excludeId: existing.id,
      siteConfig: this.siteConfig,
      // Drafts save incomplete; publish enforces required + locale.
      partial: true,
    });
    return withConflictDiagnostic(opPath, () =>
      this.entries.update({
        id: request.id,
        collection: existing.collection,
        expectedVersion: request.expectedVersion,
        data,
        now,
        hookContext: ctx,
        originalInput: request.originalInput,
      }),
    );
  }
}

function authoringContext(ctx: HandlerContext | undefined, authorId: string | null): HandlerContext {
  if (ctx) return ctx;
  return {
    user: authorId ? { id: authorId } : null,
    staff: null,
    env: {},
  };
}
