import type {
  AnyHandler,
  CreateCmsRuntimeArgs,
  PublicPathResolver,
  TemplateRegistry,
} from "@aotter/mantle-runtime";
import type { Manifest, SiteDefaults } from "@aotter/mantle-spec";
import type { Auth } from "../auth/createAuth.js";
import type { ConsumerCredentialResolver } from "./resolveCaller.js";

/**
 * Consumer-supplied config for the Cloudflare adapter mounts. `auth`
 * (Better Auth) gates `/admin/api/*` + MCP bearers. `bindings` carries
 * the three runtime-port adapters (db / kv / assets).
 */
export interface CmsConfig {
  readonly manifests: readonly Manifest[];
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly templates?: TemplateRegistry;
  readonly siteDefaults?: SiteDefaults;
  readonly publicPathResolver?: PublicPathResolver;
  readonly bindings: Pick<CreateCmsRuntimeArgs, "db" | "kv" | "assets"> & {
    /** Optional media storage adapter. When set, media MCP tools and
     *  `/admin/api/media/*` endpoints are registered. Forwarded to the
     *  runtime as `mediaStorage`. */
    readonly mediaStorage?: CreateCmsRuntimeArgs["mediaStorage"];
    /** Optional deferred-delivery dispatcher. When set, `after_*`
     *  lifecycle hooks fire through this instead of riding
     *  `ctx.waitUntil`. The Cloudflare adapter expects a
     *  `WorkersQueueHookDispatcher` bound to the `mantle_internal` queue
     *  here. */
    readonly deferredHookDispatcher?: CreateCmsRuntimeArgs["deferredHookDispatcher"];
  };
  /** Pass-through to runtime: SVG opt-in flag (default false). */
  readonly mediaAllowSvg?: boolean;
  readonly auth: Auth;
  /** Site-owned API key / personal-token verifier. Core supplies only
   *  normalization and orchestration; storage and issuance stay in
   *  consumer code. */
  readonly credentialResolver?: ConsumerCredentialResolver;
  /** Enable OAuth JWT bearer authentication on manifest REST routes. */
  readonly oauthBearer?: {
    readonly audience: string;
    readonly scopes?: readonly string[];
  };
}
