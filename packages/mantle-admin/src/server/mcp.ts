/** The Admin App is an ordinary contributor to the SDK's public MCP Apps hook. */
import { ContractError } from "@aotter/mantle/contracts";
import type { McpApps, McpAppResource } from "@aotter/mantle/mcp";
export interface AdminMcpOptions {
    readonly catalogue: {
        readonly views: Readonly<Record<string, unknown>>;
        readonly actions: Readonly<Record<string, unknown>>;
    };
    readonly html: McpAppResource["html"];
    readonly uri?: string;
    readonly title?: string;
    readonly appOnly?: readonly string[];
}
export function adminMcpApps(options: AdminMcpOptions): McpApps {
    const uri = options.uri ?? "ui://mantle-admin/admin";
    if (!/^ui:\/\/mantle-admin\/[^\s?#]+$/.test(uri))
        throw new ContractError("INPUT_VALIDATION_FAILED", "Admin App resources use ui://mantle-admin/….", "mcp/apps");
    const script = '<script type="application/json" id="mantle-catalog">' + JSON.stringify(options.catalogue).replace(/</g, "\\u003c") + "</script>";
    const embed = (html: string) => /<\/head>/i.test(html) ? html.replace(/<\/head>/i, end => script + end) : script + html;
    return { resources: [{ uri, name: "mantle-admin-admin", title: options.title ?? "Admin", html: typeof options.html === "string" ? embed(options.html) : async () => embed(await (options.html as () => string | Promise<string>)()), renders: Object.keys(options.catalogue.views), ...(options.appOnly ? { appOnly: options.appOnly } : {}) }] };
}
