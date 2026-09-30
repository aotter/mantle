/** The application-owned service, the runtime and `createMantle` (ADR-0032 decisions 4, 6, 9 and 10). */
import type { RuntimePlan } from "../spec/index.js";
import type { Caller } from "./caller.js";
import type { Invocation, MantleHandlers } from "./invocation.js";
import type { MantleStore, StoreExecutor } from "./store.js";

/** A surface is a Fetch function, created with its base path (`createMcpSurface(runtime, { basePath })`). */
export type Surface = (request: Request, caller: Caller) => Promise<Response>;

/** The sealed plan (version 6), compiled by the CLI: see `RuntimePlan` in spec. */
export type { RuntimePlan };

export interface MantleBootReport {
  readonly fingerprint: string;
  readonly coreVersion: string;
}

export interface MantleRuntime {
  readonly store: MantleStore;
  /** The one path for every Invocation: auth, guard, input, handler, output. */
  invokeProcedure(invocation: Invocation): Promise<unknown>;
  bootReport(): MantleBootReport;
}

export interface MantleServiceContext {
  readonly runtime: MantleRuntime;
  waitUntil(promise: Promise<unknown>): void;
}

/** HTTP is the service's only Mantle ingress; `env` stays opaque. */
export interface MantleService<Env = unknown> {
  readonly handlers: MantleHandlers<Env>;
  fetch(request: Request, env: Env, context: MantleServiceContext): Response | Promise<Response>;
}

export interface PreparedMantleStorage {
  readonly executor: StoreExecutor;
}

/** Converges storage to the plan (ADR-0033) and returns the executor for it. */
export interface MantleStorageAdapter {
  prepare(plan: RuntimePlan): Promise<PreparedMantleStorage>;
}
