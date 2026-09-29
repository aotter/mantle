/** `@aotter/mantle/testing`: engine-free conformance suites (ADR-0034 decision 6). */
import type { StoreExecutor } from "../core/index.js";

export interface StorageConformanceOptions {
  /** A fresh executor over an empty database, on the engine under test. */
  readonly create: () => Promise<StoreExecutor>;
}

/** Runs every StoreExecutor and lifecycle case; each driver runs it on its own engine. */
export declare function runStorageConformance(options: StorageConformanceOptions): void;
