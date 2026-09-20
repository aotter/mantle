import type { Hono } from 'hono';
import type { MantleAdminRuntime } from '@aotter/mantle/admin';
import { McpJsonRpcDispatcher, projectCallableCapabilities } from '@aotter/mantle/runtime';
import { plan } from '../.mantle/generated/mantle';
import type { Env } from './chatgpt-auth';

/** Anonymous, read-only public Views. Staff MCP needs a separate OAuth bearer flow. */
export function mountPublicMcp(app:Hono<{Bindings:Env}>, get:()=>Promise<MantleAdminRuntime>) {
  const cache=new WeakMap<object,McpJsonRpcDispatcher>();
  app.all('/api/mcp',async c=>{
    const runtime=await get();
    let dispatcher=cache.get(runtime);
    if(!dispatcher) {
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
        surface:'public',
        capabilities:projectCallableCapabilities(plan,{surface:'public'}),
        serverInfo:{name:'aotter.mantle.public',title:'Mantle public articles',websiteUrl:c.env.PUBLIC_ORIGIN},
      });
      cache.set(runtime,dispatcher);
    }
    return dispatcher.dispatch(c.req.raw,{user:null,staff:null,env:c.env,waitUntil:p=>c.executionCtx.waitUntil(p)});
  });
}
