/** Portable storage contract checks; no Node or test-framework dependency. */
export * from "./infrastructure/testing/StorageConformance.js";
/** Benchmark fixture seams, kept off the application runtime entry. */
export { DatabaseSiteConfigRepository } from "./infrastructure/persistence/DatabaseSiteConfigRepository.js";
export { ExecuteViewUseCase } from "./usecase/view/ExecuteViewUseCase.js";
export { prepareSqliteView } from "./infrastructure/storage/SqliteViewCompiler.js";
