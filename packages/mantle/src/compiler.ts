/** Deployment compiler leaves. Optional request surfaces are never constructed. */
export { compilePlan, viewOutputs } from "./spec/infrastructure/sql/compilePlan.js";
export { DiagnosticError } from "./spec/kernel/diagnostic.js";
export { parseNumeric, resolveMantleRef, NATIVE_NOT_NULL, notNullColumns, rowPolicy, writePolicy, mcpTools, mcpToolNameSegment, resolveLocalizedText, assertSiteDefaultsCanonical, canonicalizeLocaleList, expandPolicyRequired } from "./spec/domain/index.js";
export type { AuthPredicate, ManifestSourceSet, JsonSchema, RuntimePlan, PlanSchema, PlanLowered, LoweredStatement, LoweredView, LoweredPage, SqlNode, RowMode, SiteDefaults } from "./spec/index.js";
export { lowerPlan } from "./core/sql/lowered.js";
export { d1Dialect } from "./d1/dialect.js";
export { postgresDialect } from "./postgres/dialect.js";
export * as sqliteCompiler from "./d1/compile/index.js";
export * as postgresCompiler from "./postgres/compile/index.js";
export { initialStorageSql as sqliteSchema } from "./d1/storage.js";
export { initialStorageSql as postgresSchema } from "./postgres/storage.js";
export { collectionOf } from "./admin/collections.js";
export { developerConsole } from "./admin/developerConsole.js";
export { requiredEnumStates } from "./admin/procedureFlow.js";
export { checkPlanUiExtensions, planUiExtensionRefs } from "./admin/extensions.js";
export type { AdminExtension } from "./admin/extensions.js";
export { appCatalog, entrySchema } from "./mcp/catalog.js";
export type { AppRowAction } from "./mcp/catalog.js";
