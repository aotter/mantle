/**
 * `@aotter/mantle-spec` — public surface.
 *
 * Pure spec engine: kernel + domain (model + service) + usecase +
 * infrastructure (CLI). Zero env / adapter deps. Imported by
 * `mantle-runtime` (which adds dispatcher / entry-writer / view
 * executor on top) and consumed by the CLI bin.
 *
 * Layered per Aotter clean-architecture convention (mirrors
 * `aotter-mantle/mantle/core`):
 *
 *   kernel ← domain ← usecase ← infrastructure
 *
 *  - `kernel/` — cross-cutting helpers (Diagnostic shape, codes,
 *    HTTP status mapping, DiagnosticError).
 *  - `domain/model/` — pure types: ManifestGrammar (4-atom envelope +
 *    closed enums), Entry / Revision / Approval, ContentState,
 *    SiteConfig / SiteDefaults, Locale shape constants.
 *  - `domain/service/` — pure stateless algorithms operating on the
 *    domain model: LocaleCanonicalizer, LifecycleStateMachine,
 *    ManifestParser, CrossSchemaChecker, ManifestPathDiagnoser,
 *    EntryDataValidator, SchemaDdlEmitter, SiteDefaultsValidator,
 *    JsonSchemaToZod.
 *  - `usecase/` — application services: ValidateManifestsUseCase
 *    plus its request/response DTOs.
 *  - `infrastructure/` — adapters: CLI (file walking + stdout I/O).
 */
export * from "./kernel/index.js";
export * from "./domain/index.js";
export * from "./usecase/index.js";
