import type { Hono } from 'hono';
import type { AdminAuth, MantleAdminRuntime, StaffRole } from '@aotter/mantle/admin';
import { createMantleMcpHandler, type MantleMcpHandler } from '@aotter/mantle/mcp';
import { bindCapabilities, type RuntimePlan } from '@aotter/mantle/runtime';
import type { Env } from './sites-auth';

const staffRoles=new Set<string>(['owner','editor','contributor']);

/** Sites-session MCP surfaces. Remote clients still need a separate OAuth bearer flow. */
export function mountMcp(app:Hono<{Bindings:Env}>, get:()=>Promise<MantleAdminRuntime>, auth:AdminAuth, plan:RuntimePlan) {
  const cache=new WeakMap<object,Map<'public'|'staff',MantleMcpHandler>>();
  const handler=async(surface:'public'|'staff',origin:string)=>{
    const runtime=await get();
    let handlers=cache.get(runtime);
    if(!handlers)cache.set(runtime,handlers=new Map());
    let value=handlers.get(surface);
    if(!value) {
      value=createMantleMcpHandler(bindCapabilities(runtime,plan,{surface}),{serverInfo:{name:`aotter.mantle.${surface}`,title:`Mantle ${surface}`,websiteUrl:origin}});
      handlers.set(surface,value);
    }
    return value;
  };
  app.all('/api/mcp',async c=>(await handler('public',c.env.PUBLIC_ORIGIN)).fetch(c.req.raw,{user:null,staff:null,env:c.env,waitUntil:p=>c.executionCtx.waitUntil(p)}));
  app.all('/api/mcp/staff',async c=>{
    const session=await auth.getSession(c.req.raw);
    if(!session)return Response.json({error:'unauthorized'},{status:401});
    const role=session.user.roleCurrent?session.user.role:await auth.getUserRole(session.user.id);
    if(!role||!staffRoles.has(role))return Response.json({error:'forbidden'},{status:403});
    return (await handler('staff',c.env.PUBLIC_ORIGIN)).fetch(c.req.raw,{
      user:{id:session.user.id},staff:{id:session.user.id,role:role as StaffRole},
      auth:{credential:'session',credentialId:session.session.id,clientId:null,scopes:[]},
      env:c.env,waitUntil:p=>c.executionCtx.waitUntil(p),
    });
  });
}
