import type { PendingUploadRecord } from "../../src/domain/model/PendingUploadRecord.js";
import type { PendingUploadRepository } from "../../src/domain/port/PendingUploadRepository.js";

export class InMemoryPendingUploadRepository implements PendingUploadRepository {
  private readonly records = new Map<string, PendingUploadRecord>();

  async save(uploadGroupId: string, record: PendingUploadRecord): Promise<void> {
    this.records.set(uploadGroupId, record);
  }

  async findById(uploadGroupId: string): Promise<PendingUploadRecord | null> {
    return this.records.get(uploadGroupId) ?? null;
  }

  async delete(uploadGroupId: string): Promise<void> {
    this.records.delete(uploadGroupId);
  }
}
