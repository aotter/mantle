import { Hono } from 'hono';
import { bootMantleRuntime, SqliteMantleStorageAdapter } from '@aotter/mantle/runtime';
import { D1DatabaseDriver, AssetsAssetServer } from '@aotter/mantle/cloudflare';
import { mountMantleAdmin, type MantleAdminRuntime } from '@aotter/mantle/admin';
import { plan } from '../.mantle/generated/mantle';
import fingerprint from './storage-fingerprint.json';
import { createChatGPTAuth, type Env } from './chatgpt-auth';
import { mountR2Lab } from './r2-lab';
import { mountWeb } from './web';
import { SitesR2MediaStorage, mountMedia } from './media';
import { mountMcp } from './mcp';

function assemble(env:Env) {
  const auth=createChatGPTAuth(env);
  let runtime:Promise<MantleAdminRuntime>|undefined;
  const get=()=>runtime??=(async()=>{
    const r=await bootMantleRuntime({plan,storage:new SqliteMantleStorageAdapter(new D1DatabaseDriver(env.DB),{brand:'Mantle × Sites Reference',title:'Mantle × ChatGPT Sites Reference',origin:env.PUBLIC_ORIGIN,media:{purposes:[{name:'content',required:['image/jpeg,image/png,image/webp'],maxBytes:{'image/jpeg':5_000_000,'image/png':5_000_000,'image/webp':5_000_000}}]}},{managedStorageFingerprint:fingerprint}),ports:{mediaStorage:new SitesR2MediaStorage(env.MEDIA_BUCKET,env.PUBLIC_ORIGIN)}});
    if(!r.siteConfig||!r.updateSiteSettings)throw new Error('Admin storage unavailable');
    return Object.assign(r,{siteConfig:r.siteConfig,updateSiteSettings:r.updateSiteSettings});
  })().catch(error=>{runtime=undefined;throw error;});
  const app=new Hono<{Bindings:Env}>();
  app.use('*',async(c,next)=>{await next();if(!c.res.headers.has('Cache-Control'))c.header('Cache-Control','private, no-store');c.header('X-Content-Type-Options','nosniff');});
  mountWeb(app,get);
  mountMcp(app,get,auth);
  mountMedia(app,auth,env);
  app.get('/health',async()=>{await get();return Response.json({ok:true,storage:'D1',auth:'ChatGPT Sites',mantle:'0.1.2-alpha.6'});});
  app.get('/admin/sign-in',async c=>{
    if(c.req.header('cookie')?.split(';').some(v=>v.trim()==='mantle-sites-signout=1')) {
      c.header('Set-Cookie','mantle-sites-signout=; Path=/admin/sign-in; HttpOnly; SameSite=Strict; Max-Age=0'+(env.PUBLIC_ORIGIN.startsWith('https:')?'; Secure':''));
      return c.redirect('/signout-with-chatgpt?return_to=%2F');
    }
    return c.redirect(await auth.getSession(c.req.raw)?'/admin':'/signin-with-chatgpt?return_to=%2Fadmin');
  });
  app.use('/admin/*',async(c,next)=>{
    if(!c.req.path.startsWith('/admin/api/')&&!c.req.path.startsWith('/admin/lab/r2')&&!await auth.getSession(c.req.raw))return c.redirect('/signin-with-chatgpt?return_to=%2Fadmin');
    await next();
  });
  mountR2Lab(app,auth,env);
  mountMantleAdmin(app,{plan,auth,get,assets:new AssetsAssetServer(env.ASSETS),mcpEndpoints:{public:'/api/mcp',staff:'/api/mcp/staff'},requestContext:c=>({env:c.env,waitUntil:p=>c.executionCtx.waitUntil(p)})});
  app.get('/site.css',c=>env.ASSETS.fetch(c.req.raw));
  app.get('/_mantle/*',c=>env.ASSETS.fetch(c.req.raw));
  app.onError(error=>{console.error('Mantle request failed',error);return Response.json({error:'internal_error'},{status:500,headers:{'Cache-Control':'private, no-store'}});});
  return app;
}
let app:ReturnType<typeof assemble>|undefined;
export default {fetch(request:Request,env:Env,ctx:ExecutionContext){return (app??=assemble(env)).fetch(request,env,ctx);}};
