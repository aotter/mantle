import type { PendingUploadRecord } from "../model/PendingUploadRecord.js";

/** Strongly-consistent create-to-commit media-upload state. */
export interface PendingUploadRepository {
  save(uploadGroupId: string, record: PendingUploadRecord): Promise<void>;
  findById(uploadGroupId: string): Promise<PendingUploadRecord | null>;
  delete(uploadGroupId: string): Promise<void>;
}
