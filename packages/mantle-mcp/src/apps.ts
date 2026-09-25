import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
} from "@modelcontextprotocol/server";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { Capability, CapabilityCatalog, InvokeCapabilityUseCase } from "@aotter/mantle-runtime";

/** MCP Apps resource CSP (`McpUiResourceCsp`), restated so these public
 *  types never pull the ext-apps client types into a consumer's build. */
export interface MantleMcpAppCsp {
  readonly connectDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly baseUriDomains?: readonly string[];
}

/** MCP Apps sandbox permissions (`McpUiResourcePermissions`). */
export interface MantleMcpAppPermissions {
  readonly camera?: Record<string, never>;
  readonly microphone?: Record<string, never>;
  readonly geolocation?: Record<string, never>;
  readonly clipboardWrite?: Record<string, never>;
}

/**
 * One MCP Apps UI resource served on a surface (ADR-0029 D7). The HTML is a
 * reusable asset, typically the `@aotter/mantle-ui` MCP App build: it never
 * carries caller data or credentials, which travel only in tool results.
 */
export interface MantleMcpAppResource {
  /** `ui://` URI the linked tools name in `_meta.ui.resourceUri`. */
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly html: string | (() => string | Promise<string>);
  readonly csp?: MantleMcpAppCsp;
  readonly permissions?: MantleMcpAppPermissions;
  readonly prefersBorder?: boolean;
  /** Capabilities whose results this resource renders. */
  readonly renders: (capability: Capability) => boolean;
  /**
   * Capabilities only this App may call (`visibility: ["app"]`); each must
   * be declared read-only. They are not served at all to a client that
   * declares no MCP Apps support. On stateless 2025-era requests, which
   * carry no client capabilities, they are listed to every client.
   */
  readonly appOnly?: readonly string[];
}

export interface MantleMcpApps {
  readonly resources: readonly MantleMcpAppResource[];
}

/**
 * Whether this request's client renders MCP Apps. 2026-07-28 requests carry
 * the client's capabilities in their envelope and a 2025-era `initialize`
 * carries them in its params; a stateless 2025-era request after that
 * carries none, so the answer is `unknown`.
 */
export type ClientUiSupport = "supported" | "unsupported" | "unknown";

export function clientUiSupport(message: unknown): ClientUiSupport {
  const capabilities = (Array.isArray(message) ? message : [message])
    .map(declaredCapabilities)
    .find((value) => value !== undefined);
  if (capabilities === undefined) return "unknown";
  return getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ? "supported" : "unsupported";
}

function declaredCapabilities(message: unknown): ClientCapabilities | undefined {
  if (!isRecord(message) || !isRecord(message["params"])) return undefined;
  const params = message["params"];
  const meta = params["_meta"];
  if (isRecord(meta) && isRecord(meta[CLIENT_CAPABILITIES_META_KEY])) {
    return meta[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities;
  }
  if (message["method"] === "initialize" && isRecord(params["capabilities"])) {
    return params["capabilities"] as ClientCapabilities;
  }
  return undefined;
}

/** The App links of every served capability, validated once. */
export interface AppLinks {
  readonly resources: readonly MantleMcpAppResource[];
  /** Resource URI a capability renders in. */
  readonly rendersIn: ReadonlyMap<string, string>;
  /** Capabilities only an App may call, with their resource URI. */
  readonly appOnly: ReadonlyMap<string, string>;
}

/**
 * Check an Apps configuration against a surface's catalog, so adapters can
 * refuse a bad one at construction instead of on the first request. Every
 * tool links to at most one resource, whether it renders there or is
 * app-only there.
 */
export function validateApps(
  apps: MantleMcpApps | undefined,
  catalog: CapabilityCatalog,
  serves: (name: string) => boolean = () => true,
): AppLinks {
  const rendersIn = new Map<string, string>();
  const appOnly = new Map<string, string>();
  const linked = new Map<string, string>();
  const link = (tool: string, uri: string) => {
    const other = linked.get(tool);
    if (other && other !== uri) throw new TypeError(`Tool '${tool}' links to both '${other}' and '${uri}'.`);
    linked.set(tool, uri);
  };
  const uris = new Set<string>();
  for (const resource of apps?.resources ?? []) {
    if (!resource.uri.startsWith("ui://")) throw new TypeError(`MCP App resource '${resource.name}' must use a ui:// URI.`);
    if (uris.has(resource.uri)) throw new TypeError(`MCP App resource URI '${resource.uri}' is registered twice.`);
    uris.add(resource.uri);
    for (const capability of catalog.capabilities) {
      if (!serves(capability.name) || !resource.renders(capability)) continue;
      link(capability.name, resource.uri);
      rendersIn.set(capability.name, resource.uri);
    }
    for (const name of resource.appOnly ?? []) {
      const capability = catalog.get(name);
      if (!capability || !serves(name)) throw new TypeError(`App-only tool '${name}' is not served on the ${catalog.surface} surface.`);
      // An App acts on behalf of the user without the model seeing the
      // call, so only declared reads may be hidden from the model.
      if (capability.hints?.readOnly !== true) throw new TypeError(`App-only tool '${name}' must be declared read-only.`);
      link(name, resource.uri);
      appOnly.set(name, resource.uri);
    }
  }
  return { resources: apps?.resources ?? [], rendersIn, appOnly };
}

export function linkApps(apps: MantleMcpApps | undefined, invoker: InvokeCapabilityUseCase): AppLinks {
  return validateApps(apps, invoker.catalog, (name) => invoker.serves(name));
}

export async function appResourceHtml(resource: MantleMcpAppResource): Promise<string> {
  return typeof resource.html === "string" ? resource.html : await resource.html();
}

/** `_meta.ui` for a resource, or nothing when it declares nothing. */
export function appResourceMeta(resource: MantleMcpAppResource): { ui: Record<string, unknown> } | undefined {
  const ui = {
    ...(resource.csp ? { csp: resource.csp } : {}),
    ...(resource.permissions ? { permissions: resource.permissions } : {}),
    ...(resource.prefersBorder !== undefined ? { prefersBorder: resource.prefersBorder } : {}),
  };
  return Object.keys(ui).length > 0 ? { ui } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
