/** `@aotter/mantle/testing`: engine-free conformance suites (ADR-0034 decision 6). */
import type { StoreExecutor } from "../core/index.js";

/** Runs every StoreExecutor and lifecycle case; `create` returns a fresh executor over an empty database on the engine under test. */
export declare function runStorageConformance(options: { readonly create: () => Promise<StoreExecutor> }): void;
