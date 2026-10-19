/**
 * `kernel/` — cross-cutting helpers that have no domain dependencies.
 *
 * Per the clean-architecture rules: kernel imports nothing else from
 * this package. Domain / usecase / infrastructure all import here.
 */
export * from "./diagnostic.js";
