import type { Hono } from 'hono';
import { DiagnosticError, makeDiagnostic } from '@aotter/mantle/spec';
import { extensionForMime, type MediaStorage, type MediaAsset, type MediaVariant } from '@aotter/mantle/runtime';
import type { AdminAuth } from '@aotter/mantle/admin';
import type { Env } from './chatgpt-auth';

const mimes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const groupPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const filePattern = /^(primary|alternate|fallback)\.(jpg|png|webp)$/;

type Pending = { expiresAt: number; variants: { mimeType: string; storageKey: string; expectedSize: number; maxBytes: number }[] };

function failure(code: 'MEDIA_OBJECT_NOT_FOUND' | 'MEDIA_MIME_REJECTED' | 'MEDIA_VARIANT_SIZE_EXCEEDED') {
  return new DiagnosticError(makeDiagnostic({code, phase:'runtime', severity:'error', path:'sites/R2MediaStorage'}));
}

/** Public media over the Sites R2 binding; no S3 credentials or public bucket URL. */
export class SitesR2MediaStorage implements MediaStorage {
  constructor(private readonly bucket:R2Bucket, private readonly origin:string) {}

  async createUpload(args:Parameters<MediaStorage['createUpload']>[0]) {
    const capabilities=args.variants.map(variant=>{
      const storageKey=`${args.purpose}/${args.uploadGroupId}/${variant.role}.${extensionForMime(variant.mimeType)}`;
      return {
        mimeType:variant.mimeType, role:variant.role, method:'PUT' as const,
        uploadUrl:`${this.origin}/admin/media-upload/${args.uploadGroupId}/${storageKey.split('/').at(-1)}`,
        storageKey, publicUrl:`${this.origin}/media/${storageKey}`,
        requiredHeaders:{'Content-Type':variant.mimeType},
      };
    });
    return {uploadGroupId:args.uploadGroupId, capabilities, expiresAt:args.expiresAt};
  }

  async commitUpload(args:Parameters<MediaStorage['commitUpload']>[0]):Promise<MediaAsset> {
    const checked=[] as {spec:(typeof args.variants)[number]; size:number}[];
    for(const spec of args.variants) {
      const head=await this.bucket.head(spec.storageKey);
      if(!head)throw failure('MEDIA_OBJECT_NOT_FOUND');
      if(head.httpMetadata?.contentType!==spec.mimeType)throw failure('MEDIA_MIME_REJECTED');
      if(head.size>spec.maxBytes)throw failure('MEDIA_VARIANT_SIZE_EXCEEDED');
      checked.push({spec,size:head.size});
    }
    const variants:MediaVariant[]=[];
    for(const {spec,size} of checked) {
      const object=await this.bucket.get(spec.storageKey);
      if(!object)throw failure('MEDIA_OBJECT_NOT_FOUND');
      await this.bucket.put(spec.storageKey,object.body,{
        httpMetadata:{contentType:spec.mimeType},
        customMetadata:{...object.customMetadata,committedAt:String(args.now),uploadGroupId:args.uploadGroupId,role:spec.role,filename:args.filename},
      });
      variants.push({mimeType:spec.mimeType,role:spec.role,storageKey:spec.storageKey,byteSize:size,publicUrl:await this.getPublicUrl({storageKey:spec.storageKey})});
    }
    return {id:args.uploadGroupId,variants,alt:args.alt,caption:args.caption,createdAt:args.now,metadata:{filename:args.filename}};
  }

  async getPublicUrl({storageKey}:Parameters<MediaStorage['getPublicUrl']>[0]) {return `${this.origin}/media/${storageKey}`;}
  async deleteObject({storageKey}:Parameters<MediaStorage['deleteObject']>[0]) {await this.bucket.delete(storageKey);}
}

export function mountMedia(app:Hono<{Bindings:Env}>,auth:AdminAuth,env:Env) {
  app.put('/admin/media-upload/:group/:file',async c=>{
    const session=await auth.getSession(c.req.raw);
    if(!session)return c.json({error:'unauthenticated'},401);
    if(session.user.role!=='owner'&&session.user.role!=='editor')return c.json({error:'editor_required'},403);
    if(c.req.header('origin')!==env.PUBLIC_ORIGIN)return c.json({error:'cross_origin'},403);
    const group=c.req.param('group'),file=c.req.param('file');
    if(!groupPattern.test(group)||!filePattern.test(file))return c.json({error:'invalid_upload'},400);
    const row=await env.DB.prepare('SELECT record FROM pending_media_uploads WHERE id=?').bind(group).first<{record:string}>();
    if(!row)return c.json({error:'upload_expired'},410);
    const pending=JSON.parse(row.record) as Pending;
    if(pending.expiresAt<=Date.now())return c.json({error:'upload_expired'},410);
    const key=`content/${group}/${file}`;
    const variant=pending.variants.find(v=>v.storageKey===key);
    if(!variant||!mimes.has(variant.mimeType))return c.json({error:'invalid_upload'},400);
    if(c.req.header('content-type')!==variant.mimeType)return c.json({error:'mime_rejected'},415);
    const length=Number(c.req.header('content-length'));
    if(Number.isFinite(length)&&length>variant.expectedSize)return c.json({error:'size_exceeded'},413);
    if(!c.req.raw.body)return c.json({error:'empty_upload'},400);
    // R2 put requires a fixed-length body. Bound memory to this validated 5 MB policy.
    const reader=c.req.raw.body.getReader(),chunks:Uint8Array[]=[];
    let bytes=0;
    for(;;) {
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>variant.expectedSize){await reader.cancel();return c.json({error:'size_exceeded'},413);}
      chunks.push(value);
    }
    if(bytes!==variant.expectedSize)return c.json({error:'size_mismatch'},400);
    const body=new Uint8Array(bytes);
    let offset=0;
    for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
    await env.MEDIA_BUCKET.put(key,body,{httpMetadata:{contentType:variant.mimeType}});
    return c.body(null,204);
  });

  app.get('/media/:purpose/:group/:file',async c=>{
    const {purpose,group,file}=c.req.param();
    if(purpose!=='content'||!groupPattern.test(group)||!filePattern.test(file))return c.notFound();
    const key=`${purpose}/${group}/${file}`;
    const row=await env.DB.prepare('SELECT variants FROM media_assets WHERE id=?').bind(group).first<{variants:string}>();
    if(!row)return c.notFound();
    const variants=JSON.parse(row.variants) as MediaVariant[];
    if(!variants.some(v=>v.storageKey===key))return c.notFound();
    const object=await env.MEDIA_BUCKET.get(key);
    if(!object||!mimes.has(object.httpMetadata?.contentType??''))return c.notFound();
    return new Response(object.body,{headers:{'Content-Type':object.httpMetadata!.contentType!,'Content-Length':String(object.size),'Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'}});
  });
}
