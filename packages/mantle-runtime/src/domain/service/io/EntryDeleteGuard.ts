import {
  DiagnosticError,
  resolveLifecycle,
  runtimeDiagnostic,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../model/EntryRow.js";
import { notFoundDiagnostic } from "../EntryMutationDiagnostics.js";

export interface AssertEntryDeletableArgs {
  readonly entry: EntryRow;
  readonly schema: SchemaManifest | undefined;
  readonly expectedCollection?: string;
  readonly opPath: string;
}

/** Shared policy for generic and schema-bound delete paths. */
export function assertEntryDeletable(args: AssertEntryDeletableArgs): void {
  const { entry, expectedCollection, opPath } = args;
  if (expectedCollection && entry.collection !== expectedCollection) {
    throw new DiagnosticError(notFoundDiagnostic(opPath, expectedCollection, entry.id));
  }
  if (entry.status !== "published" || resolveLifecycle(args.schema) === "operational") return;
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "CONFLICT",
      severity: "error",
      path: opPath,
      value: entry.status,
      expected: "an unpublished entry",
      message: `Published entry '${entry.id}' cannot be deleted. Unpublish it first.`,
    }),
  );
}
