import type { SiteConfig } from "@aotter/mantle-spec";

/**
 * Request DTO for `RenderEntryLiveUseCase` — renders a single entry
 * from current DB state on demand (no KV read), returning either the
 * full HTML doc or `null` if no matching entry / no registered
 * template.
 */
export interface RenderEntryLiveRequest {
  readonly collection: string;
  readonly slug: string;
  readonly locale: string;
  readonly site: SiteConfig;
}
