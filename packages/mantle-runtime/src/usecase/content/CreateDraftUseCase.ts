import {
  DiagnosticError,
  resolveLifecycle,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { Clock } from "../../domain/port/Clock.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { IdGenerator } from "../../domain/port/IdGenerator.js";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";
import { projectAndStamp } from "../../domain/service/BuiltinProjector.js";
import type { CreateDraftRequest } from "../dto/content/index.js";
import {
  schemaUnknownDiagnostic,
  withConflictDiagnostic,
} from "./diagnostics.js";
import { assertEntryWritable } from "../../domain/service/io/EntryWriteGuard.js";

/**
 * `CreateDraftUseCase` — create a draft for content lifecycles, or a
 * live row for `lifecycle: none` operational records.
 */
export class CreateDraftUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly clock: Clock,
    private readonly idgen: IdGenerator,
    private readonly siteConfig?: SiteConfigRepository,
  ) {}

  async execute(request: CreateDraftRequest): Promise<EntryRow> {
    const opPath = `usecase/CreateDraft/${request.collection}`;
    const schema = this.schemas.get(request.collection);
    if (!schema) {
      throw new DiagnosticError(
        schemaUnknownDiagnostic(opPath, request.collection, [...this.schemas.keys()]),
      );
    }
    const id = this.idgen.next();
    const now = this.clock.now();
    const ctx = authoringContext(request.ctx, request.authorId);
    const lifecycle = resolveLifecycle(schema);
    const data = projectAndStamp({ schema, input: request.data, ctx, clockNow: now });
    await assertEntryWritable({
      opPath,
      entries: this.entries,
      schema,
      data,
      siteConfig: this.siteConfig,
      // Real drafts save incomplete; lifecycle:none records are live immediately.
      partial: lifecycle !== "none",
    });
    return withConflictDiagnostic(opPath, () =>
      this.entries.create({
        id,
        collection: request.collection,
        // Operational records (lifecycle: none) have no publish step —
        // they are live the moment they exist.
        status: lifecycle === "none" ? "published" : "draft",
        data,
        authorId: request.authorId,
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
