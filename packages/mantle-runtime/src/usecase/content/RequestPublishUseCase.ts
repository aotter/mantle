import {
  canTransition,
  DiagnosticError,
  publishRequiresApproval,
  resolveLifecycle,
  runtimeDiagnostic,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { Clock } from "../../domain/port/Clock.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";
import type { RequestPublishRequest } from "../dto/content/index.js";
import {
  illegalTransitionDiagnostic,
  notFoundDiagnostic,
  withConflictDiagnostic,
} from "./diagnostics.js";
import { assertEntryWritable } from "../../domain/service/io/EntryWriteGuard.js";

/**
 * `RequestPublishUseCase` — publish or queue-for-approval, depending
 * on the Schema's `lifecycle` mode.
 *
 * v0.1.0 ships the `simple` publish workflow — request goes straight to
 * `published` with a status guard via the spec's state machine. The Schema parser
 * accepts `lifecycle: editorial` (it's a v0.1.x-committed mode in
 * `V01_LIFECYCLE_MODES`), so this use case is the only line of
 * defense: when a Schema declares `editorial`, it surfaces a
 * structured `LIFECYCLE_NOT_IN_V010` error here at request time.
 * The approvals-queue branch lands in v0.1.x.
 */
export class RequestPublishUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly clock: Clock,
    private readonly siteConfig?: SiteConfigRepository,
  ) {}

  async execute(request: RequestPublishRequest): Promise<EntryRow> {
    const opPath = `usecase/RequestPublish/${request.id}`;
    const existing = await this.entries.get(request.id);
    if (!existing) {
      throw new DiagnosticError(notFoundDiagnostic(opPath, "<unknown>", request.id));
    }
    const schema = this.schemas.get(existing.collection);
    if (publishRequiresApproval(schema)) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "LIFECYCLE_NOT_IN_V010",
          severity: "error",
          path: opPath,
          value: resolveLifecycle(schema),
          expected: "lifecycle: 'simple' for request_publish ('none' records are already operational; editorial lands in v0.1.x)",
          message: `Schema '${existing.collection}' uses lifecycle: 'editorial'; its approval/request-publish runtime lands in v0.1.x.`,
        }),
      );
    }

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
