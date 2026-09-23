import type { Hono } from 'hono';
import type { MantleAdminRuntime } from '@aotter/mantle/admin';
import { createMantleWeb, createPublicPathResolver, composeEntrySeoMeta, composePageSeoMeta, renderSeoTagsHtml, serializeEntryAsMarkdown, TemplateRegistry } from '@aotter/mantle-web';
import { micromark } from 'micromark';
import type { Env } from './chatgpt-auth';

const paths=createPublicPathResolver({collectionRoutes:{articles:{segment:'articles'}}});
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const articlePath=(id:string)=>`/articles/${encodeURIComponent(id)}`;
const shell=(title:string,head:string,body:string)=>`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>${head}<link rel="stylesheet" href="/site.css"><style>.article-cover{margin:36px 0}.article-cover img{display:block;width:100%;height:auto;border-radius:12px}.prose img{max-width:100%;height:auto}</style></head><body><header class="topbar"><a class="brand" href="/"><span class="mark">M</span><span>Mantle <em>×</em> Sites</span></a><nav aria-label="主要導覽"><a href="/articles">文章</a><a href="/admin">管理後台 ↗</a></nav></header>${body}<footer><span>Mantle on ChatGPT Sites</span><a href="/llms.txt">給 AI 的內容索引</a></footer></body></html>`;
const templates=new TemplateRegistry();
templates.registerListTemplate('articles',({entries,nextPageUrl})=>`<section class="article-list">${entries.length?entries.map(entry=>`<article class="article-row"><div class="article-number">${new Date(entry.updatedAt).toLocaleDateString('zh-TW',{timeZone:'UTC'})}</div><div><h2><a href="${articlePath(entry.id)}">${escape(entry.data.title)}</a></h2><p>${escape(entry.data.summary||'閱讀完整文章')}</p></div><span aria-hidden="true">↗</span></article>`).join(''):'<div class="empty"><h2>文章準備中</h2><p>在管理後台發布文章後，就會自動出現在這裡。</p></div>'}</section>${nextPageUrl?`<nav class="pagination" aria-label="分頁"><a rel="next" href="${escape(nextPageUrl)}">更多文章 →</a></nav>`:''}`);

export function mountWeb(app:Hono<{Bindings:Env}>,get:()=>Promise<MantleAdminRuntime>) {
  const load=async()=>{const runtime=await get();return {runtime,site:await runtime.siteConfig.load(),web:createMantleWeb(runtime,{templates,paths})};};
  const list=async(cursor?:string)=>{const {site,web}=await load();const seo=composePageSeoMeta({site,locale:'zh-TW',publicPath:'/articles',title:`文章｜${site.title}`,description:site.description||'由 Mantle 管理與發布的文章。',markdown:false,pathForLocale:()=>'/articles'});const page=await web.renderListLive.execute({collection:'articles',locale:'zh-TW',contentLocale:null,site,seo,cursor,limit:20,pathForPage:next=>`/articles?cursor=${encodeURIComponent(next)}`});return shell(`文章｜${site.title}`,renderSeoTagsHtml(seo),`<main><section class="hero small"><p class="eyebrow">THE JOURNAL</p><h1>文章與觀察<span class="dot">.</span></h1><p class="hero-copy">內容由 Mantle 後台管理，從 D1 即時讀取。</p></section><div class="content-wrap">${page?.html.replace(/^<!doctype html>/i,'')??''}</div></main>`);};
  app.get('/',async c=>{const {site}=await load();const seo=composePageSeoMeta({site,locale:'zh-TW',publicPath:'/',title:site.title,description:site.description||'Mantle 在 ChatGPT Sites 上的內容實驗。',markdown:false,pathForLocale:()=>'/'});return c.html(shell(site.title,renderSeoTagsHtml(seo),`<main><section class="hero"><p class="eyebrow">BUILT WITH MANTLE · RUNNING ON CHATGPT SITES</p><h1>內容、資料、<br>與下一種網站<span class="dot">.</span></h1><p class="hero-copy">這個站點連接 Mantle 管理後台與 Sites 的 D1 資料庫。文章發布後，會自動生成可閱讀、可索引的頁面。</p><div class="actions"><a class="button" href="/articles">探索文章 <span>↗</span></a><a class="text-link" href="/admin">進入管理後台 →</a></div></section><section class="feature-grid" aria-label="網站能力"><div><span class="feature-index">01 / CONTENT</span><h2>一處編輯</h2><p>文章在 Mantle 後台建立與發布，前台直接讀取同一份內容。</p></div><div><span class="feature-index">02 / DISCOVERY</span><h2>搜尋與 AI 可讀</h2><p>標準 metadata、結構化資料、Markdown 鏡像與內容索引。</p></div><div><span class="feature-index">03 / PLATFORM</span><h2>託管於 Sites</h2><p>D1 保存文章，R2 圖片可在後台上傳並綁定文章封面。</p></div></section></main>`));});
  app.get('/articles',async c=>c.html(await list(c.req.query('cursor'))));
  app.get('/articles/:id',async c=>{const {runtime,site}=await load();const rawId=c.req.param('id');const markdown=rawId.endsWith('.md');const entry=await runtime.entries.readById({collection:'articles',id:markdown?rawId.slice(0,-3):rawId});if(!entry||entry.status!=='published')return c.notFound();if(markdown){const text=serializeEntryAsMarkdown(entry);return text?c.text(text,200,{'Content-Type':'text/markdown; charset=utf-8'}):c.notFound();}
    const coverId=typeof entry.data.coverAssetId==='string'?entry.data.coverAssetId:'';
    const cover=coverId?await runtime.media?.resolve(coverId):null;
    const primary=cover?.variants.find(v=>v.role==='primary');
    const coverUrl=primary?.publicUrl;
    const seoEntry=coverUrl?{...entry,data:{...entry.data,coverUrl}}:entry;
    const path=articlePath(entry.id),seo=composeEntrySeoMeta({entry:seoEntry,site,publicPath:path,locale:'zh-TW',type:'article'});
    const title=String(entry.data.title??site.title);
    const image=coverUrl?`<figure class="article-cover"><img src="${escape(coverUrl)}" alt="${escape(cover?.alt||title)}" loading="eager"></figure>`:'';
    const body=micromark(String(entry.data.body??''),{allowDangerousHtml:false,allowDangerousProtocol:false});
    return c.html(shell(`${title}｜${site.title}`,renderSeoTagsHtml(seo),`<main class="article-page"><a class="back" href="/articles">← 返回文章</a><article><p class="eyebrow">ARTICLE · ${new Date(entry.updatedAt).toLocaleDateString('zh-TW',{timeZone:'UTC'})}</p><h1>${escape(title)}</h1>${entry.data.summary?`<p class="lede">${escape(entry.data.summary)}</p>`:''}${image}<div class="prose">${body}</div></article></main>`));});
  // ponytail: one discovery page is enough for this lab; expose cursor pages when published articles exceed the SDK page limit.
  app.get('/llms.txt',async c=>{const {site,web}=await load();const page=await web.composeLlmsTxt.execute({collections:['articles'],locale:null,site,pathFor:e=>articlePath(e.id)});const body=page?.body??`# ${site.title}\n\n文章索引：${site.origin}/articles\n`;return c.text(body,200,{'Content-Type':'text/plain; charset=utf-8'});});
  // ponytail: first 1000 published URLs; add sitemap index parts only when the catalogue reaches that ceiling.
  app.get('/sitemap.xml',async c=>{const {site,web}=await load();const page=await web.composeSitemap.execute({site,collections:['articles'],pathFor:e=>articlePath(e.id),additionalPaths:['/','/articles'],maxUrls:1000});return c.text(page.body,200,{'Content-Type':'application/xml; charset=utf-8'});});
  app.get('/robots.txt',async c=>c.text(`User-agent: *\nAllow: /\nSitemap: ${c.env.PUBLIC_ORIGIN}/sitemap.xml\n`));
}
