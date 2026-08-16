import {
  SqliteMantleStorageAdapter,
  createMantleRuntime,
  prepareDeployment,
  type MantleRuntime,
  type RuntimePlan,
  type SiteConfigRepository,
} from "@aotter/mantle-runtime";
import { createMantleWeb, type MantleWeb } from "@aotter/mantle-web";
import type { AdminAssetServer } from "@aotter/mantle-admin";
import type { Auth } from "../auth/createAuth.js";
import type { MantleCloudflareConfig } from "./cmsConfig.js";
import type { ConsumerCredentialResolver } from "./resolveCaller.js";

/**
 * Per-isolate runtime singleton. The cached promise MUST reset on
 * rejection (PR #29 carry-forward) — otherwise a transient D1 error
 * during boot poisons the isolate permanently and every subsequent
 * request re-throws the same rejected promise.
 */
export interface MantleRuntimeRef {
  get(): Promise<CloudflareMantleRuntime>;
  web(runtime: CloudflareMantleRuntime): MantleWeb;
  readonly plan: RuntimePlan;
  readonly auth: Auth;
  readonly adminAssets?: AdminAssetServer;
  readonly credentialResolver?: ConsumerCredentialResolver;
  readonly jwtBearer?: MantleCloudflareConfig["jwtBearer"];
}

export type CloudflareMantleRuntime = MantleRuntime & {
  readonly siteConfig: SiteConfigRepository;
  readonly updateSiteSettings: NonNullable<MantleRuntime["updateSiteSettings"]>;
};

export function createMantleRuntimeRef(config: MantleCloudflareConfig): MantleRuntimeRef {
  let booted: Promise<CloudflareMantleRuntime> | null = null;
  let web: MantleWeb | null = null;
  const storage = new SqliteMantleStorageAdapter(config.bindings.db, config.siteDefaults);
  return {
    plan: config.plan,
    auth: config.auth,
    adminAssets: config.bindings.adminAssets,
    credentialResolver: config.credentialResolver,
    jwtBearer: config.jwtBearer,
    web(runtime): MantleWeb {
      return web ??= createMantleWeb(runtime, {
        templates: config.templates,
        paths: config.publicPathResolver,
        mediaAssets: runtime.media ?? undefined,
      });
    },
    get(): Promise<CloudflareMantleRuntime> {
      if (booted) return booted;
      booted = bootWithD1Retry(async () => {
        const prepared = await prepareDeployment(config.plan, storage, {
          handlerNames: Object.keys(config.handlers ?? {}),
          reservedHttpPathPrefixes: config.reservedHttpPathPrefixes,
        });
        const runtime = createMantleRuntime({
          plan: config.plan,
          prepared,
          handlers: config.handlers,
          ports: {
            deferredHookDispatcher: config.bindings.deferredHookDispatcher,
            mediaStorage: config.bindings.mediaStorage,
            mediaAllowSvg: config.mediaAllowSvg,
            onPublishingContentChange: config.onPublicChange,
          },
        });
        if (!runtime.siteConfig || !runtime.updateSiteSettings) {
          throw new Error("Cloudflare SQLite storage did not prepare site configuration.");
        }
        return runtime as CloudflareMantleRuntime;
      })
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

async function bootWithD1Retry(
  create: () => Promise<CloudflareMantleRuntime>,
): Promise<CloudflareMantleRuntime> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await create();
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
