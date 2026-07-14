import type { SiteConfig } from "@aotter/mantle-spec";
import type { TemplateRegistry } from "../model/TemplateRegistry.js";

/**
 * `PublishOrchestrator` — the publish-pipeline surface adapters call
 * after a successful `requestPublish` to materialize HTML / `.md` /
 * list pages / `llms.txt` into the `KvCache`.
 *
 * `TemplateRegistry` is consumer-supplied (`createCmsRuntime` accepts
 * it); rendering is idempotent — two invocations with the same entry
 * id are safe.
 *
 * The HTML implementation is in
 * `infrastructure/render/HtmlPublishOrchestrator`.
 */
export interface PublishOrchestrator {
  publish(request: PublishEntryRequest): Promise<void>;
  unpublish(request: PublishEntryRequest): Promise<void>;
}

export interface PublishEntryRequest {
  readonly entryId: string;
  readonly site: SiteConfig;
  readonly templates: TemplateRegistry;
}
