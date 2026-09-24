import { DiagnosticError, runtimeDiagnostic, type ContentState } from "@aotter/mantle-spec";
import { liftLocale, type EntryRow } from "../../domain/model/EntryRow.js";
import type { AtomicEntryWrite, AtomicEntryWriter } from "../../domain/port/AtomicEntryWriter.js";
import type { CreateDraftRequest, DeleteEntryRequest, UpdateDraftRequest } from "../dto/content/index.js";
import type { CreateDraftUseCase } from "./CreateDraftUseCase.js";
import type { DeleteEntryUseCase } from "./DeleteEntryUseCase.js";
import type { UpdateDraftUseCase } from "./UpdateDraftUseCase.js";
import { withConflictDiagnostic } from "./diagnostics.js";

export type AtomicDraftOperation =
  | { readonly kind: "create"; readonly id?: string; readonly request: CreateDraftRequest }
  | { readonly kind: "update"; readonly request: UpdateDraftRequest }
  | { readonly kind: "delete"; readonly request: DeleteEntryRequest & {
      readonly expectedVersion: number;
      readonly expectedStatus?: ContentState;
    } };

/** Declarative entry mutations; all preparation and before hooks precede one storage batch. */
export class AtomicEntryWriteUseCase {
  constructor(
    private readonly writer: AtomicEntryWriter | undefined,
    private readonly create: CreateDraftUseCase,
    private readonly update: UpdateDraftUseCase,
    private readonly remove: DeleteEntryUseCase,
    private readonly hooksFor: (write: AtomicEntryWrite, previous: EntryRow | null) => {
      readonly before: () => Promise<void>;
      readonly after: (row: EntryRow) => Promise<void>;
    },
    private readonly invalidate?: () => Promise<void>,
    private readonly affectsPublishing?: (collection: string) => boolean,
  ) {}

  async execute(operations: readonly AtomicDraftOperation[]): Promise<readonly (EntryRow | null)[]> {
    if (!this.writer) {
      throw new DiagnosticError(runtimeDiagnostic({
        code: "RESOURCE_UNAVAILABLE",
        severity: "error",
        path: "usecase/AtomicEntryWrite",
        expected: "storage adapter with atomicEntries capability",
        message: "This storage adapter does not support atomic entry writes.",
      }));
    }
    const prepared: { write: AtomicEntryWrite; previous: EntryRow | null; result: EntryRow | null }[] = [];
    const touched = new Set<string>();
    for (const operation of operations) {
      let previous: EntryRow | null = null;
      let write: AtomicEntryWrite;
      if (operation.kind === "create") {
        if (operation.id !== undefined && (typeof operation.id !== "string" || !operation.id || operation.id.includes("\0"))) {
          throw invalidOperation("Create id must be a non-empty string without NUL.");
        }
        write = { kind: "create", args: await this.create.prepare(operation.request, {
          id: operation.id, skipUniquePreflight: true,
        }) };
      } else if (operation.kind === "update") {
        const preparedUpdate = await this.update.prepare(operation.request, { skipUniquePreflight: true });
        previous = preparedUpdate.previous;
        write = { kind: "update", args: {
          ...preparedUpdate.args, observedVersion: previous.version,
        } };
      } else if (operation.kind === "delete") {
        const preparedDelete = await this.remove.prepare(operation.request);
        previous = preparedDelete.previous;
        write = { kind: "delete", args: {
          ...preparedDelete.args,
          expectedVersion: operation.request.expectedVersion,
          expectedStatus: operation.request.expectedStatus ?? preparedDelete.args.expectedStatus,
          observedVersion: previous.version,
          observedStatus: previous.status,
        } };
      } else {
        throw invalidOperation("Atomic operation kind must be create, update, or delete.");
      }
      if (write.kind !== "create" && (!Number.isSafeInteger(write.args.expectedVersion) || write.args.expectedVersion < 1)) {
        throw invalidOperation("Update and delete require a positive expectedVersion.");
      }
      const key = `${write.args.collection}\0${write.args.id}`;
      if (touched.has(key)) throw invalidOperation("An atomic group may touch each entry only once.");
      touched.add(key);
      const result: EntryRow | null = write.kind === "create"
        ? { id: write.args.id, collection: write.args.collection, locale: liftLocale(write.args.data),
            status: write.args.status, version: 1, data: write.args.data, authorId: write.args.authorId,
            createdAt: write.args.now, updatedAt: write.args.now }
        : write.kind === "update"
          ? { ...previous!, data: write.args.data, locale: liftLocale(write.args.data),
              version: write.args.expectedVersion + 1, updatedAt: write.args.now }
          : null;
      prepared.push({ write, previous, result });
    }
    const hooks = prepared.map(({ write, previous }) => this.hooksFor(write, previous));
    for (const hook of hooks) await hook.before();
    await withConflictDiagnostic("usecase/AtomicEntryWrite", () =>
      this.writer!.writeAtomically(prepared.map(({ write }) => write)));
    for (let i = 0; i < hooks.length; i += 1) {
      const row = prepared[i]!.result ?? prepared[i]!.previous;
      if (row) await hooks[i]!.after(row);
    }
    if (this.invalidate && prepared.some(({ write }) => this.affectsPublishing?.(write.args.collection))) {
      try { await this.invalidate(); } catch (error) {
        console.error("[mantle] public cache invalidation failed after committed write", error);
      }
    }
    return prepared.map(({ result }) => result);
  }
}

function invalidOperation(message: string): DiagnosticError {
  return new DiagnosticError(runtimeDiagnostic({
    code: "INPUT_VALIDATION_FAILED", severity: "error", path: "usecase/AtomicEntryWrite", message,
  }));
}
