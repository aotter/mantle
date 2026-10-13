/** Cookie-only Admin dispatch uses the same generated validation and invocation as MCP. */
import { ContractError } from "@aotter/mantle/contracts";
import { callToolLazy as callTool, type Tool } from "@aotter/mantle/mcp";
import { json, type Route } from "./index.js";
export function webmcpRoutes<Env, Database, Handlers>(catalogue: {
    readonly tools: readonly {
        readonly name: string;
    }[];
}, tools: readonly Tool<Database, Handlers>[], ...args: [Handlers] extends [never] ? [handlers?: undefined] : [handlers: NoInfer<Handlers>]): readonly Route<Env, Database>[] {
    const selected = tools.filter(tool => tool.surface === "admin" && catalogue.tools.some(item => item.name === tool.name));
    return [{ method: "POST", path: "/webmcp/{tool}", run: async (c) => {
                const tool = selected.find(tool => tool.name === c.params.tool);
                if (!tool)
                    throw new ContractError("NOT_FOUND", "No such admin tool.", "admin/webmcp");
                return { output: await callTool(tool, await json(c), () => c.db, c.caller, args[0] as Handlers) };
            } }];
}
