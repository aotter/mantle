import type { Hono } from 'hono';
import { McpJsonRpcDispatcher, projectCallableCapabilities, type MantleRuntime, type RuntimePlan } from '@aotter/mantle/runtime';
import type { Env } from './sites-env';

export function mountPublicMcp(app:Hono<{Bindings:Env}>,get:()=>Promise<MantleRuntime>,plan:RuntimePlan) {
  let current:MantleRuntime|undefined;
  let dispatcher:McpJsonRpcDispatcher|undefined;
  app.all('/api/mcp',async c=>{
    const runtime=await get();
    if(current!==runtime){
      current=runtime;
      dispatcher=new McpJsonRpcDispatcher({
        getEntry:runtime.getEntry,
        createDraft:runtime.createDraft,
        updateDraft:runtime.updateDraft,
        requestPublish:runtime.requestPublish,
        unpublish:runtime.unpublish,
        archive:runtime.archive,
        deleteEntry:runtime.deleteEntry,
        executeView:{execute:request=>runtime.executeView({...request,view:request.view.metadata.name})},
        invokeTrigger:{execute:request=>runtime.invokeTrigger(request)},
      },[...runtime.schemas.values()],{
        surface:'public',capabilities:projectCallableCapabilities(plan,{surface:'public'}),
        serverInfo:{name:'aotter.mantle.public',title:'Mantle public',websiteUrl:c.env.PUBLIC_ORIGIN},
      });
    }
    return dispatcher!.dispatch(c.req.raw,{user:null,staff:null,env:c.env,waitUntil:p=>c.executionCtx.waitUntil(p)});
  });
}
