import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
} from "@modelcontextprotocol/server";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpUiResourceCsp, McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps";
import type { Capability, InvokeCapabilityUseCase } from "@aotter/mantle-runtime";

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
  readonly csp?: McpUiResourceCsp;
  readonly permissions?: McpUiResourcePermissions;
  readonly prefersBorder?: boolean;
  /** Capabilities whose results this resource renders. */
  readonly renders: (capability: Capability) => boolean;
  /**
   * Read-only capabilities only this App may call (`visibility: ["app"]`).
   * They are not served at all to a client that declares no MCP Apps
   * support.
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

export function linkApps(apps: MantleMcpApps | undefined, invoker: InvokeCapabilityUseCase): AppLinks {
  const rendersIn = new Map<string, string>();
  const appOnly = new Map<string, string>();
  const uris = new Set<string>();
  for (const resource of apps?.resources ?? []) {
    if (!resource.uri.startsWith("ui://")) throw new TypeError(`MCP App resource '${resource.name}' must use a ui:// URI.`);
    if (uris.has(resource.uri)) throw new TypeError(`MCP App resource URI '${resource.uri}' is registered twice.`);
    uris.add(resource.uri);
    for (const capability of invoker.catalog.capabilities) {
      if (!invoker.serves(capability.name) || !resource.renders(capability)) continue;
      const other = rendersIn.get(capability.name);
      if (other) throw new TypeError(`Tool '${capability.name}' renders in both '${other}' and '${resource.uri}'.`);
      rendersIn.set(capability.name, resource.uri);
    }
    for (const name of resource.appOnly ?? []) {
      const capability = invoker.catalog.get(name);
      if (!capability || !invoker.serves(name)) throw new TypeError(`App-only tool '${name}' is not served on this surface.`);
      // An App acts on behalf of the user without the model seeing the
      // call, so only reads may be hidden from the model.
      if (capability.hints?.readOnly !== true) throw new TypeError(`App-only tool '${name}' must be read-only.`);
      appOnly.set(name, resource.uri);
    }
  }
  return { resources: apps?.resources ?? [], rendersIn, appOnly };
}

export async function appResourceHtml(resource: MantleMcpAppResource): Promise<string> {
  return typeof resource.html === "string" ? resource.html : await resource.html();
}

export function appResourceMeta(resource: MantleMcpAppResource) {
  return {
    ui: {
      ...(resource.csp ? { csp: resource.csp } : {}),
      ...(resource.permissions ? { permissions: resource.permissions } : {}),
      ...(resource.prefersBorder !== undefined ? { prefersBorder: resource.prefersBorder } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
