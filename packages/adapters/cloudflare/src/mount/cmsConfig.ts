import type {
  AnyHandler,
  DatabaseDriver,
  DeferredHookDispatcher,
  MediaStorage,
  RuntimePlan,
} from "@aotter/mantle-runtime";
import type { AdminAssetServer } from "@aotter/mantle-admin";
import type { PublicPathResolver, TemplateRegistry } from "@aotter/mantle-web";
import type { SiteDefaults } from "@aotter/mantle-spec";
import type { Auth } from "../auth/createAuth.js";
import type { ConsumerCredentialResolver } from "./resolveCaller.js";

/**
 * Consumer-supplied config for the Cloudflare adapter mounts. `auth`
 * (Better Auth) gates `/admin/api/*` + MCP bearers. `bindings` carries
 * runtime and selected capability adapters.
 */
export interface MantleCloudflareConfig {
  readonly plan: RuntimePlan;
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly templates?: TemplateRegistry;
  readonly siteDefaults?: SiteDefaults;
  readonly publicPathResolver?: PublicPathResolver;
  /** Routes owned by the capabilities this composition actually mounts. */
  readonly reservedHttpPathPrefixes?: readonly string[];
  readonly bindings: { readonly db: DatabaseDriver } & {
    /** Optional Admin SPA assets. Omitting this mounts no Admin surface. */
    readonly adminAssets?: AdminAssetServer;
    /** Optional media storage adapter. When set, media MCP tools and
     *  `/admin/api/media/*` endpoints are registered. Forwarded to the
     *  runtime as `mediaStorage`. */
    readonly mediaStorage?: MediaStorage;
    /** Optional at-least-once dispatcher. When set, `after_*`
     *  lifecycle hooks enqueue after the entry write; a rejected send
     *  falls back to best-effort `ctx.waitUntil`/inline execution. The
     *  Cloudflare adapter expects a
     *  `WorkersQueueHookDispatcher` bound to the `mantle-internal` queue
     *  here. */
    readonly deferredHookDispatcher?: DeferredHookDispatcher;
  };
  /** Pass-through to runtime: SVG opt-in flag (default false). */
  readonly mediaAllowSvg?: boolean;
  readonly auth: Auth;
  /** Site-owned API key / personal-token verifier. Core supplies only
   *  normalization and orchestration; storage and issuance stay in
   *  consumer code. */
  readonly credentialResolver?: ConsumerCredentialResolver;
  /** Enable OAuth JWT bearer authentication on manifest REST routes. */
  readonly jwtBearer?: {
    readonly audience: string;
    readonly scopes?: readonly string[];
  };
  readonly onPublicChange?: () => Promise<void>;
}
