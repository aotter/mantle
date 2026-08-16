import type { LinkedManifestSet } from "../../domain/service/ManifestLinker.js";

export interface EmitOpenapiRequest {
  readonly linked: LinkedManifestSet;
  readonly title: string;
  readonly version: string;
  /**
   * Better Auth session cookie name surfaced in the OpenAPI
   * `sessionCookie` security scheme for auth-gated targets. Defaults to
   * `__Secure-better-auth.session_token` (production default — Better
   * Auth adds `__Secure-` when baseURL is HTTPS). Override to
   * `better-auth.session_token` for local/non-secure deployments.
   * Prefer `security.sessionCookie.name` in new callers; this field is
   * retained for source compatibility.
   */
  readonly sessionCookieName?: string;
  /** Credential transports enabled by the adapter. Session-cookie
   *  auth defaults on for backward compatibility; all other schemes
   *  are opt-in so emitted OpenAPI cannot claim unsupported bearer or
   *  API-key behavior. */
  readonly security?: {
    readonly sessionCookie?: false | { readonly name?: string };
    readonly oauthBearer?: {
      /** OIDC discovery URL used by OpenAPI's openIdConnect scheme. */
      readonly openIdConnectUrl: string;
    };
    readonly apiKey?: {
      readonly name: string;
      readonly in: "header" | "query" | "cookie";
    };
    readonly personalToken?: {
      readonly bearerFormat?: string;
    };
  };
}
