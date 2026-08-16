import {
  canTransition,
  DiagnosticError,
  EntryDataValidator,
  runtimeDiagnostic,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { Clock } from "../../domain/port/Clock.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { LocalePolicyReader } from "../../domain/port/SiteConfigRepository.js";
import type { RequestPublishRequest } from "../dto/content/index.js";
import {
  illegalTransitionDiagnostic,
  notFoundDiagnostic,
  withConflictDiagnostic,
} from "./diagnostics.js";
import { assertEntryWritable } from "../../domain/service/io/EntryWriteGuard.js";

/**
 * `RequestPublishUseCase` — publish with a status guard via the
 * Schema's state machine.
 */
export class RequestPublishUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly clock: Clock,
    private readonly siteConfig?: LocalePolicyReader,
    private readonly validator = new EntryDataValidator(),
  ) {}

  async execute(request: RequestPublishRequest): Promise<EntryRow> {
    const opPath = `usecase/RequestPublish/${request.id}`;
    const existing = await this.entries.get(request.id);
    if (!existing) {
      throw new DiagnosticError(notFoundDiagnostic(opPath, "<unknown>", request.id));
    }
    const schema = this.schemas.get(existing.collection);
    if (!canTransition(schema, existing.status, "published")) {
      throw new DiagnosticError(
        illegalTransitionDiagnostic(opPath, existing.status, "published"),
      );
    }
    if (schema) {
      await assertEntryWritable({
        opPath,
        entries: this.entries,
        schema,
        data: existing.data,
        validator: this.validator,
        excludeId: existing.id,
        siteConfig: this.siteConfig,
      });
    }
    await this.assertTranslatesParentPublished(opPath, existing, schema);

    const published = await withConflictDiagnostic(opPath, () =>
      this.entries.transitionStatus({
        id: request.id,
        collection: existing.collection,
        to: "published",
        expectedStatus: existing.status,
        // Validation above ran against this version; a concurrent
        // UpdateDraft between then and the flip must fail rather than
        // publish stale-but-passed data.
        expectedVersion: existing.version,
        now: this.clock.now(),
        hookContext: request.ctx,
        originalInput: request.originalInput,
      }),
    );
    return published;
  }

  private async assertTranslatesParentPublished(
    path: string,
    entry: EntryRow,
    schema: SchemaManifest | undefined,
  ): Promise<void> {
    const translates = schema?.spec.translates;
    if (!translates) return;

    const value = entry.data[translates.on];
    if (value === undefined || value === null || value === "") {
      throw missingTranslatesParentDiagnostic(path, entry, translates, value);
    }
    const parent = await this.entries.findByDataField({
      collection: translates.parent,
      status: "published",
      field: translates.on,
      value,
    });
    if (parent) return;

    throw missingTranslatesParentDiagnostic(path, entry, translates, value);
  }
}

function missingTranslatesParentDiagnostic(
  path: string,
  entry: EntryRow,
  translates: { readonly parent: string; readonly on: string },
  value: unknown,
): DiagnosticError {
  return new DiagnosticError(
    runtimeDiagnostic({
      code: "TRANSLATES_PARENT_UNKNOWN",
      severity: "error",
      path: `${path}/translates`,
      value: {
        child: entry.collection,
        parent: translates.parent,
        field: translates.on,
        value,
      },
      expected: `published parent entry in '${translates.parent}' where data.${translates.on} === ${JSON.stringify(value)}`,
      message: `Cannot publish '${entry.collection}' translation '${entry.id}' because no published parent '${translates.parent}' entry has ${translates.on}=${JSON.stringify(value)}. Publish the parent first.`,
    }),
  );
}
