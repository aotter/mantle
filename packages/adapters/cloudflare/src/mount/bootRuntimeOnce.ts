import {
  createCmsRuntime,
  type CmsRuntime,
} from "@aotter/mantle-runtime";
import type { Manifest } from "@aotter/mantle-spec";
import type { Auth } from "../auth/createAuth.js";
import type { CmsConfig } from "./cmsConfig.js";
import type { ConsumerCredentialResolver } from "./resolveCaller.js";

/**
 * Per-isolate runtime singleton. The cached promise MUST reset on
 * rejection (PR #29 carry-forward) — otherwise a transient D1 error
 * during boot poisons the isolate permanently and every subsequent
 * request re-throws the same rejected promise.
 */
export interface CmsRuntimeRef {
  get(): Promise<CmsRuntime>;
  readonly manifests: readonly Manifest[];
  readonly auth: Auth;
  readonly credentialResolver?: ConsumerCredentialResolver;
  readonly jwtBearer?: CmsConfig["jwtBearer"];
}

export function createCmsRef(config: CmsConfig): CmsRuntimeRef {
  const runtime = createCmsRuntime({
    manifests: config.manifests,
    handlers: config.handlers,
    templates: config.templates,
    siteDefaults: config.siteDefaults,
    reservedHttpPathPrefixes: [config.auth.basePath],
    publicPathResolver: config.publicPathResolver,
    mediaAllowSvg: config.mediaAllowSvg,
    db: config.bindings.db,
    assets: config.bindings.assets,
    mediaStorage: config.bindings.mediaStorage,
    deferredHookDispatcher: config.bindings.deferredHookDispatcher,
    onPublicChange: config.onPublicChange,
  });

  let booted: Promise<CmsRuntime> | null = null;
  return {
    manifests: config.manifests,
    auth: config.auth,
    credentialResolver: config.credentialResolver,
    jwtBearer: config.jwtBearer,
    get(): Promise<CmsRuntime> {
      if (booted) return booted;
      booted = bootWithD1Retry(runtime)
        .catch((err) => {
          booted = null;
          console.error("[mantle] runtime boot failed", errorDetails(err));
          throw err;
        });
      return booted;
    },
  };
}

const MAX_BOOT_ATTEMPTS = 3;
const RETRYABLE_D1_ERRORS = [
  "network connection lost",
  "storage caused object to be reset",
  "reset because its code was updated",
] as const;

async function bootWithD1Retry(runtime: CmsRuntime): Promise<CmsRuntime> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runtime.bootInit();
      return runtime;
    } catch (error) {
      if (attempt >= MAX_BOOT_ATTEMPTS || !isRetryableD1Error(error)) throw error;
      console.warn("[mantle] transient D1 boot failure; retrying", {
        attempt,
        ...errorDetails(error),
      });
      const backoffMs = 50 * (2 ** (attempt - 1));
      await new Promise((resolve) =>
        setTimeout(resolve, backoffMs + Math.floor(Math.random() * backoffMs)),
      );
    }
  }
}

function isRetryableD1Error(error: unknown): boolean {
  const details = errorDetails(error);
  const text = `${details.message}\n${details.cause ?? ""}`.toLowerCase();
  return RETRYABLE_D1_ERRORS.some((needle) => text.includes(needle));
}

function errorDetails(error: unknown): {
  readonly name: string;
  readonly message: string;
  readonly cause?: string;
  readonly stack?: string;
} {
  if (!(error instanceof Error)) {
    return { name: typeof error, message: String(error) };
  }
  const cause = error.cause instanceof Error
    ? error.cause.message
    : error.cause === undefined
      ? undefined
      : String(error.cause);
  return {
    name: error.name,
    message: error.message,
    ...(cause ? { cause } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
  };
}
