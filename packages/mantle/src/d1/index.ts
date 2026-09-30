/**
 * `@aotter/mantle/d1`: the built-in dialect's runtime side (ADR-0035 decision 6). ADR-0034's subset check, the SQLite
 * rendering and codec, FTS5 and R*Tree lowering, and trigger-based convergence, over any SQLite-family `DatabaseDriver`.
 */
export { sqliteStorage } from "./adapter.js";
