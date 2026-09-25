import type { Hono } from 'hono';
import { createMantleMcpHandler, type MantleMcpHandler } from '@aotter/mantle/mcp';
import { bindCapabilities, type MantleRuntime, type RuntimePlan } from '@aotter/mantle/runtime';
import type { Env } from './sites-env';

export function mountPublicMcp(app:Hono<{Bindings:Env}>,get:()=>Promise<MantleRuntime>,plan:RuntimePlan) {
  let current:MantleRuntime|undefined;
  let handler:MantleMcpHandler|undefined;
  app.all('/api/mcp',async c=>{
    const runtime=await get();
    if(current!==runtime){
      current=runtime;
      handler=createMantleMcpHandler(bindCapabilities(runtime,plan,{surface:'public'}),{serverInfo:{name:'aotter.mantle.public',title:'Mantle public',websiteUrl:c.env.PUBLIC_ORIGIN}});
    }
    return handler!.fetch(c.req.raw,{user:null,staff:null,env:c.env,waitUntil:p=>c.executionCtx.waitUntil(p)});
  });
}
