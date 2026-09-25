import type { Hono } from 'hono';
import type { AdminAuth, MantleAdminRuntime, StaffRole } from '@aotter/mantle/admin';
import { createMcpDispatcher, type McpJsonRpcDispatcher, type RuntimePlan } from '@aotter/mantle/runtime';
import type { Env } from './sites-auth';

const staffRoles=new Set<string>(['owner','editor','contributor']);

/** Sites-session MCP surfaces. Remote clients still need a separate OAuth bearer flow. */
export function mountMcp(app:Hono<{Bindings:Env}>, get:()=>Promise<MantleAdminRuntime>, auth:AdminAuth, plan:RuntimePlan) {
  const cache=new WeakMap<object,Map<'public'|'staff',McpJsonRpcDispatcher>>();
  const dispatcher=async(surface:'public'|'staff',origin:string)=>{
    const runtime=await get();
    let dispatchers=cache.get(runtime);
    if(!dispatchers)cache.set(runtime,dispatchers=new Map());
    let value=dispatchers.get(surface);
    if(!value) {
      value=createMcpDispatcher(runtime,plan,{surface,serverInfo:{name:`aotter.mantle.${surface}`,title:`Mantle ${surface}`,websiteUrl:origin}});
      dispatchers.set(surface,value);
    }
    return value;
  };
  app.all('/api/mcp',async c=>(await dispatcher('public',c.env.PUBLIC_ORIGIN)).dispatch(c.req.raw,{user:null,staff:null,env:c.env,waitUntil:p=>c.executionCtx.waitUntil(p)}));
  app.all('/api/mcp/staff',async c=>{
    const session=await auth.getSession(c.req.raw);
    if(!session)return Response.json({error:'unauthorized'},{status:401});
    const role=session.user.roleCurrent?session.user.role:await auth.getUserRole(session.user.id);
    if(!role||!staffRoles.has(role))return Response.json({error:'forbidden'},{status:403});
    return (await dispatcher('staff',c.env.PUBLIC_ORIGIN)).dispatch(c.req.raw,{
      user:{id:session.user.id},staff:{id:session.user.id,role:role as StaffRole},
      auth:{credential:'session',credentialId:session.session.id,clientId:null,scopes:[]},
      env:c.env,waitUntil:p=>c.executionCtx.waitUntil(p),
    });
  });
}
