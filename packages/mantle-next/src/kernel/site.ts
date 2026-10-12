/** Optional site capability. Construction does no database work; deployment facts come from generated constants. */
import { deny, type Caller } from "./contracts.js";
import { invalid } from "./surface.js";
import { mediaLibrary, type MediaDatabase } from "./media.js";
import type { Dialect } from "./dialect/common.js";
import type { MantleSite, SiteDefaults, SiteConfig, MediaPurposePolicy } from "./site-types.js";
export type { MantleSite, SiteDefaults, SiteConfig, MediaStorage, MediaAsset, MediaLibrary, MediaPurposePolicy } from "./site-types.js";
const icons = [{src:"/admin/favicon.png",mimeType:"image/png",sizes:["64x64"]},{src:"/admin/favicon.svg",mimeType:"image/svg+xml",sizes:["any"]}];
export function createSite(db: MediaDatabase, d: Pick<Dialect,"param"|"escapeLike"|"likeEscape"|"like">, caller: Caller, defaults: SiteDefaults, policies: readonly MediaPurposePolicy[]): MantleSite {
  const staff = () => deny(caller, caller.kind === "user" && String(caller.role) === "staff", "site");
  const read = async (): Promise<SiteConfig> => {
    const stored = Object.fromEntries((await db.read("SELECT key, value FROM site_config", [])).map(row=>[String(row.key),String(row.value)]));
    const locales = defaults.locales ?? [];
    return {brand: stored.brand || defaults.brand || "AotterMantle", title: stored.title ?? defaults.title ?? "CMS", description: stored.description ?? defaults.description ?? "", origin: defaults.origin ?? "", locales, canonicalLocale: locales[0] ?? null, icons: defaults.icons ?? icons, media:{purposes:defaults.media?.purposes ?? []}};
  };
  return { read, async updateSettings(values) {
    staff();
    if (!values || typeof values !== "object" || Array.isArray(values)) invalid("Site settings must be an object.", "site/settings");
    const steps = (["brand","title","description"] as const).flatMap(key => values[key] === undefined ? [] : [{sql:`INSERT INTO site_config (key,value) VALUES (${d.param(1)},${d.param(2)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,binds:[key,values[key]]}]);
    for (const key of ["brand","title","description"] as const) if (values[key] !== undefined && (typeof values[key] !== "string" || values[key]!.length > {brand:80,title:200,description:1000}[key])) invalid(`Invalid site setting ${key}`, "site/settings");
    if (steps.length) await db.write(steps);
    return read();
  }, media(storage) { staff(); return mediaLibrary(db,d,storage,policies); } };
}

/** 0.2 /admin/api/site projection; the app supplies its selected capabilities and extensions. */
export function siteInfo(config: SiteConfig, options: {origin:string;media?:boolean;invitationEmail?:boolean;mcpEndpoints?:{public?:string|null;staff?:string|null};extensions?:readonly unknown[];siteSettings?:boolean}) {
  const {origin,...stored}=config;
  const publicUrl=URL.canParse(origin) ? origin : options.origin;
  const at=(path:string|null|undefined)=>path ? new URL(path,publicUrl).href : null;
  return {...stored,publicUrl,mcpEndpoints:{public:at(options.mcpEndpoints?.public),staff:at(options.mcpEndpoints?.staff)},capabilities:{siteSettings:options.siteSettings??true,media:!!options.media,invitationEmail:!!options.invitationEmail,statistics:false},extensions:options.extensions??[]};
}
