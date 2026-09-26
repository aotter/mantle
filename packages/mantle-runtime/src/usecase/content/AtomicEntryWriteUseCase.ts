import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle-spec";
import { liftLocale, type EntryRow } from "../../domain/model/EntryRow.js";
import type { AtomicEntryWrite, AtomicEntryWriter } from "../../domain/port/AtomicEntryWriter.js";
import type { CreateDraftRequest, DeleteEntryRequest, UpdateDraftRequest } from "../dto/content/index.js";
import type { StoreWhere } from "../../domain/model/Store.js";
import type { CreateDraftUseCase } from "./CreateDraftUseCase.js";
import type { DeleteEntryUseCase } from "./DeleteEntryUseCase.js";
import type { UpdateDraftUseCase } from "./UpdateDraftUseCase.js";
import { withConflictDiagnostic } from "./diagnostics.js";

export type AtomicDraftOperation =
  | { readonly kind: "create"; readonly id?: string; readonly request: CreateDraftRequest }
  | { readonly kind: "update"; readonly request: UpdateDraftRequest }
  | { readonly kind: "delete"; readonly request: DeleteEntryRequest & { readonly expectedVersion: number } }
  | { readonly kind: "deleteWhere"; readonly request: {
      readonly collection: string;
      readonly where: StoreWhere;
      readonly expect?: number;
    } };

/** One operation's result: the written row (null for deletes) and the rows it affected. */
export interface AtomicWriteOutcome {
  readonly row: EntryRow | null;
  readonly affected: number;
}

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
    private readonly invalidate: (() => Promise<void>) | undefined,
    private readonly affectsPublishing: (collection: string) => boolean,
    /**
     * Why a Schema refuses set-based deletes: `unknown` Schema, per-row delete
     * `hooks` it would skip, or `published` entries it could remove.
     */
    private readonly deleteWherePolicy: (collection: string) => "ok" | "unknown" | "hooks" | "published",
  ) {}

  async execute(operations: readonly AtomicDraftOperation[]): Promise<readonly AtomicWriteOutcome[]> {
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
    const current = await this.readTargets(operations);
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
        const preparedUpdate = await this.update.prepare(operation.request, {
          skipUniquePreflight: true, ...current(operation.request),
        });
        previous = preparedUpdate.previous;
        write = { kind: "update", args: {
          ...preparedUpdate.args, observedVersion: previous.version,
        } };
      } else if (operation.kind === "delete") {
        const preparedDelete = await this.remove.prepare(operation.request, current(operation.request));
        previous = preparedDelete.previous;
        write = { kind: "delete", args: {
          ...preparedDelete.args,
          expectedVersion: operation.request.expectedVersion,
          observedVersion: previous.version,
        } };
      } else if (operation.kind === "deleteWhere") {
        const { collection, where, expect } = operation.request;
        const policy = this.deleteWherePolicy(collection);
        if (policy === "unknown") throw invalidOperation(`Unknown Schema '${String(collection)}'.`);
        if (policy === "hooks") {
          throw invalidOperation(`Schema '${collection}' has delete lifecycle Triggers; delete its entries one by one with where { id } and lock.`);
        }
        if (policy === "published") {
          throw invalidOperation(`Schema '${collection}' uses the publishing lifecycle, where published entries cannot be deleted; delete its entries one by one with where { id } and lock.`);
        }
        if (expect !== undefined && (!Number.isSafeInteger(expect) || expect < 0)) {
          throw invalidOperation("expect must be a non-negative integer.");
        }
        this.writer.assertDeleteWhere(collection, where);
        prepared.push({ write: { kind: "deleteWhere", args: { collection, where, ...(expect === undefined ? {} : { expect }) } }, previous: null, result: null });
        continue;
      } else {
        throw invalidOperation("Atomic operation kind must be create, update, delete, or deleteWhere.");
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
    const affected = await withConflictDiagnostic("usecase/AtomicEntryWrite", () =>
      this.writer!.writeAtomically(prepared.map(({ write }) => write)));
    for (let i = 0; i < hooks.length; i += 1) {
      const row = prepared[i]!.result ?? prepared[i]!.previous;
      if (row) await hooks[i]!.after(row);
    }
    if (this.invalidate && prepared.some(({ write }) => this.affectsPublishing(write.args.collection))) {
      try { await this.invalidate(); } catch (error) {
        console.error("[mantle] public cache invalidation failed after committed write", error);
      }
    }
    return prepared.map(({ result }, i) => ({ row: result, affected: affected[i] ?? 0 }));
  }

  /**
   * Reads every update and delete target up front, one query per collection,
   * when the writer can. The batch still guards each observed version, so
   * this changes the number of round trips, not what the group asserts.
   */
  private async readTargets(operations: readonly AtomicDraftOperation[]):
    Promise<(key: { readonly collection: string; readonly id: string }) => { previous?: EntryRow | null }> {
    const readForWrite = this.writer?.readForWrite?.bind(this.writer);
    if (!readForWrite) return () => ({});
    const ids = new Map<string, Set<string>>();
    for (const operation of operations) {
      if ((operation.kind !== "update" && operation.kind !== "delete") ||
        typeof operation.request?.collection !== "string" || typeof operation.request.id !== "string") continue;
      const set = ids.get(operation.request.collection) ?? new Set<string>();
      set.add(operation.request.id);
      ids.set(operation.request.collection, set);
    }
    const rows = new Map<string, EntryRow>();
    for (const [collection, set] of ids) {
      try {
        for (const row of await readForWrite(collection, [...set])) rows.set(`${collection}\0${row.id}`, row);
      } catch {
        // An unreadable collection (e.g. an unknown Schema) is left to each
        // operation's own read, so errors still surface in operation order.
        ids.delete(collection);
      }
    }
    return (key) => ids.get(key.collection)?.has(key.id)
      ? { previous: rows.get(`${key.collection}\0${key.id}`) ?? null } : {};
  }
}

function invalidOperation(message: string): DiagnosticError {
  return new DiagnosticError(runtimeDiagnostic({
    code: "INPUT_VALIDATION_FAILED", severity: "error", path: "usecase/AtomicEntryWrite", message,
  }));
}
