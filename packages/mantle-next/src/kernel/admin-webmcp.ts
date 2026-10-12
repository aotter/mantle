/** Admin's existing session/origin gate surrounds both routes; the MCP SDK is unnecessary. */
import { ContractError } from "./contracts.js";
import { body, type Route } from "./admin.js";
import type { Tool } from "./mcp.js";
import { callTool } from "./mcp-call.js";

export function webmcpRoutes<Env, Database, Handlers>(catalogue: {readonly tools: readonly {readonly name:string}[];readonly routes:unknown}, tools: readonly Tool<Database, Handlers>[], handlers: Handlers): readonly Route<Env, Database>[] {
  const selected=tools.filter(tool=>tool.surface==="staff"&&catalogue.tools.some(item=>item.name===tool.name));
  return [
    {method:"POST",path:"/webmcp/{tool}",run:async({request,db,caller,params})=>{
      const tool=selected.find(tool=>tool.name===params.tool);
      if(!tool)throw new ContractError("NOT_FOUND","No such staff tool.","admin/webmcp");
      return {output:await callTool(tool,await body(request),db,caller,handlers)};
    }},
  ];
}
