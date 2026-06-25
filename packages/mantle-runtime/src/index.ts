/**
 * `@aotter/mantle-runtime` — public surface.
 *
 * Adapter-agnostic runtime engine for mantle. Layered per the
 * Aotter clean-architecture convention (mirrors `aotter-mantle/mantle/core`):
 *
 *   domain ← usecase ← infrastructure ← runtime.ts (assembly root)
 *
 * Adapters (e.g. `@aotter/mantle-cloudflare`) implement the
 * required port interfaces in `domain/port/` and call `createCmsRuntime`
 * to compose everything. Optional feature ports (for example media
 * hosting) stay adapter-agnostic and are only wired when enabled.
 *
 * MUST NOT import `D1Database` / `KVNamespace` / any Cloudflare-
 * specific type. The Netlify stub package exists as a public reminder.
 */

// Assembly root.
export {
  createCmsRuntime,
  type CreateCmsRuntimeArgs,
  type CmsRuntime,
} from "./runtime.js";

// Adapter-facing ports. These are the stable boundary platform
// adapters implement; runtime-internal seams remain off the root
// surface unless there is a concrete consumer need.
export type {
  DatabaseDriver,
  PreparedStatement,
  RunResult,
  BatchResult,
  MigrationRunner,
  Migration,
} from "./domain/port/DatabaseDriver.js";
export type { KvCache, KvPutOptions, KvListResult } from "./domain/port/KvCache.js";
export type { AssetServer } from "./domain/port/AssetServer.js";
export type {
  MediaStorage,
  CreateUploadArgs,
  CreateUploadVariantSpec,
  CreateUploadResult,
  UploadCapability,
  CommitUploadArgs,
  CommitUploadVariantSpec,
  GetPublicUrlArgs,
  DeleteObjectArgs,
  MediaAsset,
  MediaVariant,
  MediaVariantRole,
} from "./domain/port/MediaStorage.js";
export { pickPrimaryVariant } from "./domain/port/MediaStorage.js";
export type { MediaAssetRepository } from "./domain/port/MediaAssetRepository.js";
export type {
  EmailSender,
  EmailSendArgs,
} from "./domain/port/EmailSender.js";
export { extensionForMime } from "./usecase/media/mediaAllowlist.js";
export type {
  DeferredHookDispatcher,
  DeferredHookEnvelope,
  CtxSnapshot,
} from "./domain/port/DeferredHookDispatcher.js";

// ID source — adapters wire this into binding-side helpers that need
// random IDs. Default `RandomUuidGenerator` (`crypto.randomUUID()`)
// can be swapped in tests with a deterministic counter.
export { type IdGenerator, RandomUuidGenerator } from "./domain/port/IdGenerator.js";

// Consumer/starter handler and render contracts.
export type {
  AnyHandler,
  HandlerContext,
} from "./domain/model/HandlerContext.js";
export type { SeoMeta } from "./domain/model/SeoMeta.js";
export {
  TemplateRegistry,
  type EntryContext,
  type ListContext,
  type EntryTemplate,
  type ListTemplate,
} from "./domain/model/TemplateRegistry.js";
export {
  createPublicPathResolver,
  type PublicPathResolver,
  type PublicPathResolverConfig,
  type CollectionRoute,
} from "./domain/service/PublicPathResolver.js";
export {
  composeEntrySeoMeta,
  renderSeoTagsHtml,
  type ComposeEntrySeoMetaArgs,
  type SiblingTranslation,
} from "./domain/service/SeoMetaComposer.js";

// Public route / starter fixture helpers. These are intentionally
// exported one-by-one instead of exposing the whole service barrel.
export {
  entryHtmlKey,
  entryMarkdownKey,
  entryHtmlKeyFromParts,
  entryMarkdownKeyFromParts,
  listHtmlKey,
  llmsTxtKey,
} from "./domain/service/PublishKeys.js";
export { serializeEntryAsMarkdown } from "./domain/service/MarkdownSerializer.js";
export { readEntryBySlug } from "./domain/service/io/PublishedEntries.js";
export {
  inferLocaleFromPath,
  isKnownLocale,
  siteConfigFromDefaults,
  toUrlLocale,
} from "./domain/service/LocaleNegotiator.js";
export { matchPath } from "./domain/service/PathMatcher.js";
export { evaluateAuthAll } from "./domain/service/AuthPredicateEvaluator.js";
export {
  coerceViewParams,
  ViewParamCoercionError,
} from "./domain/service/ViewParamCoercer.js";

// Explicit adapter contract for the Cloudflare MCP mount. Do not
// export the whole MCP infrastructure barrel from the root.
export {
  McpJsonRpcDispatcher,
  type McpAuthContext,
  type McpUseCases,
} from "./infrastructure/mcp/McpJsonRpcDispatcher.js";

// Starter fixture support. Kept explicit so persistence/http
// infrastructure do not become root public API by accident.
export { CANONICAL_MIGRATIONS } from "./infrastructure/boot/canonicalMigrations.js";

// Procedure handler failure carrier used by platform helper handlers
// such as Cloudflare Turnstile.
export { InvokeFailure } from "./usecase/procedure/InvokeProcedureUseCase.js";
