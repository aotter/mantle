/**
 * `@aotter/mantle/spec`: the manifest grammar, its checks, and the SQL front end that compiles a plan (CLI only).
 * Layers: `kernel/` (Diagnostic), `domain/` (model and pure services), `usecase/` (manifest validation, type emission),
 * `infrastructure/sql/` (`compileSql`, `compilePlan`; the one place `libpg-query` loads).
 */
export * from "./kernel/index.js";
export * from "./domain/index.js";
export * from "./usecase/index.js";
// The Store SQL compiler (ADR-0034). `libpg-query` loads on the first `compileSql` call only,
// so a runtime that imports this barrel never instantiates the WASM.
export * from "./infrastructure/sql/index.js";
