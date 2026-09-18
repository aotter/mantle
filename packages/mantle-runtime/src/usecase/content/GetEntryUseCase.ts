import { DiagnosticError } from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { GetEntryRequest } from "../dto/content/index.js";
import { notFoundDiagnostic } from "./diagnostics.js";

/**
 * `GetEntryUseCase` — fetch one row from its compiled Schema collection.
 */
export class GetEntryUseCase {
  constructor(private readonly entries: EntryRepository) {}

  async execute(request: GetEntryRequest): Promise<EntryRow> {
    const opPath = `usecase/GetEntry/${request.id}`;
    const row = await this.entries.get(request);
    if (!row) {
      throw new DiagnosticError(
        notFoundDiagnostic(opPath, request.collection, request.id),
      );
    }
    return row;
  }
}
