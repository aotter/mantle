import {
  DiagnosticError,
  EntryDataValidator,
  resolveLifecycle,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { Clock } from "../../domain/port/Clock.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { IdGenerator } from "../../domain/port/IdGenerator.js";
import type { LocalePolicyReader } from "../../domain/port/SiteConfigRepository.js";
import { projectAndStamp } from "../../domain/service/BuiltinProjector.js";
import type { CreateDraftRequest } from "../dto/content/index.js";
import {
  schemaUnknownDiagnostic,
  withConflictDiagnostic,
} from "./diagnostics.js";
import { assertEntryWritable } from "../../domain/service/io/EntryWriteGuard.js";
import { authoringContext } from "./AuthoringContext.js";

/**
 * `CreateDraftUseCase` — create a draft for content lifecycles, or a
 * live row for `lifecycle: operational` records.
 */
export class CreateDraftUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly clock: Clock,
    private readonly idgen: IdGenerator,
    private readonly siteConfig?: LocalePolicyReader,
    private readonly validator = new EntryDataValidator(),
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
      validator: this.validator,
      siteConfig: this.siteConfig,
      // Real drafts save incomplete; operational records are live immediately.
      partial: lifecycle !== "operational",
    });
    return withConflictDiagnostic(opPath, () =>
      this.entries.create({
        id,
        collection: request.collection,
        // Operational records have no publish step —
        // they are live the moment they exist.
        status: lifecycle === "operational" ? "published" : "draft",
        data,
        authorId: request.authorId,
        now,
        hookContext: ctx,
        originalInput: request.originalInput,
      }),
    );
  }
}
