import type { Hono } from 'hono';
import type { AdminAuth } from '@aotter/mantle/admin';
import type { Env } from './chatgpt-auth';

// Deliberately a binding probe, not an implementation of Mantle's public MediaStorage port.
export function mountR2Lab(app:Hono<{Bindings:Env}>,auth:AdminAuth,env:Env) {
  app.use('/admin/lab*',async(c,next)=>{
    const session=await auth.getSession(c.req.raw);
    if(!session)return c.json({error:'unauthenticated'},401);
    if(session.user.role!=='owner')return c.json({error:'owner_required'},403);
    if(c.req.method!=='GET'&&c.req.header('origin')!==env.PUBLIC_ORIGIN)return c.json({error:'cross_origin'},403);
    await next();
  });
  app.get('/admin/lab',c=>c.html(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>R2 驗證 · Mantle Sites</title><style>body{font:18px system-ui;max-width:760px;margin:60px auto;padding:24px;background:#101820;color:#eef5ff}a{color:#69dbff}button{font:inherit;padding:12px 20px;cursor:pointer}pre{white-space:pre-wrap}</style><h1>R2 binding 驗證</h1><p>以目前的 owner 身分寫入一個測試物件，在另一個請求讀取並核對內容，最後清理該物件。這不是媒體庫上傳測試。</p><button id="run">執行 R2 測試</button><pre id="result" role="status"></pre><a href="/admin">回管理後台</a><script>
const button=document.querySelector('#run'),result=document.querySelector('#result');
button.onclick=async()=>{button.disabled=true;result.textContent='測試中…';let id;try{
const send=async(method,path)=>{const r=await fetch(path,{method});if(!r.ok)throw Error('HTTP '+r.status);return r.json()};
const created=await send('POST','/admin/lab/r2');id=created.id;
const read=await send('GET','/admin/lab/r2/'+id);if(!read.matches)throw Error('內容不一致');
const deleted=await send('DELETE','/admin/lab/r2/'+id);if(!deleted.deleted)throw Error('清理未完成');id=null;
result.textContent='PASS：R2 PUT → HEAD / GET（另一個請求）→ 內容核對 → DELETE / HEAD 確認已清理。';
}catch(e){result.textContent='FAIL：'+e.message+(id?'；待清理測試 ID：'+id:'')}finally{button.disabled=false}};
</script></html>`));
  app.post('/admin/lab/r2',async c=>{
    const id=crypto.randomUUID();
    await env.MEDIA_BUCKET.put(`_sites_binding_probe/${id}`,`mantle-sites-r2:${id}`,{httpMetadata:{contentType:'text/plain'},customMetadata:{purpose:'disposable-binding-probe'}});
    return c.json({id});
  });
  app.on(['GET','DELETE'],'/admin/lab/r2/:id',async c=>{
    const id=c.req.param('id');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))return c.json({error:'invalid_id'},400);
    const key=`_sites_binding_probe/${id}`,head=await env.MEDIA_BUCKET.head(key);
    if(!head||head.customMetadata?.purpose!=='disposable-binding-probe')return c.json({error:'not_found'},404);
    if(c.req.method==='DELETE'){await env.MEDIA_BUCKET.delete(key);return c.json({deleted:await env.MEDIA_BUCKET.head(key)===null});}
    const object=await env.MEDIA_BUCKET.get(key);
    return c.json({matches:!!object&&await object.text()===`mantle-sites-r2:${id}`,size:head.size});
  });
}
