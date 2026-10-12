/** Generate the optional site/media module and deployment DDL, never runtime preparation. */
import { assertSiteDefaultsCanonical, canonicalizeLocaleList, expandPolicyRequired, type SiteDefaults } from "@aotter/mantle/spec";
import type { Target } from "../domain/model.js";
export function emitSite(target: Target, defaults: SiteDefaults | undefined, refuse: (path:string,message:string)=>void, schemaNames: readonly string[]): Record<string,string> {
  if (!defaults) return {};
  try { assertSiteDefaultsCanonical(defaults); } catch (error) { refuse("site",String((error as Error).message)); return {}; }
  for (const name of schemaNames) if (["site_config","media_assets","pending_media_uploads"].includes(name.toLowerCase())) refuse(`schemas/${name}`, "This table name is reserved by the selected site/media module.");
  if (new Set(defaults.media?.purposes?.map(p=>p.name)).size !== (defaults.media?.purposes?.length ?? 0)) refuse("site/media/purposes", "Media purpose names must be unique.");
  defaults = {...defaults, ...(defaults.locales ? {locales:canonicalizeLocaleList(defaults.locales).valid} : {})};
  const pg = target.endsWith("postgres"), driver = target === "bun-sqlite" ? "bun-sqlite" : target === "cloudflare-d1" ? "d1" : "postgres";
  const policies = defaults.media?.purposes?.map(p=>({...p,required:expandPolicyRequired(p.required).map(slot=>slot.join(","))})) ?? [];
  const seed = (["brand","title","description"] as const).filter(key=>defaults![key]).map(key=>`INSERT INTO site_config (key,value) VALUES ('${key}','${defaults![key]!.replaceAll("'","''")}') ON CONFLICT(key) DO NOTHING;`).join("\n");
  const root = "@aotter/mantle-next";
  return {"site.ts":`import { createSite } from "${root}/site";
import type { Caller } from "${root}/contracts";
import type { ${pg ? "Postgres" : "Handle"} as Database } from "${root}/${pg ? "contracts" : `driver/${driver}`}";
import * as DRIVER from "${root}/driver/${driver}";
import { param, escapeLike, likeEscape, like } from "${root}/dialect/${pg ? "postgres" : "sqlite"}";
export const siteDefaults = ${JSON.stringify(defaults)} as const;
const policies = ${JSON.stringify(policies)} as const;
export function site(db: Database, caller: Caller) { return createSite({read:(sql,values)=>DRIVER.read(db,sql,values),write:steps=>DRIVER.procedure(db,steps,"site"),definitive:DRIVER.definitive},{param,escapeLike,likeEscape,like},caller,siteDefaults,policies); }
`,"site-seed.sql": seed + "\n", "site-schema.sql":`CREATE TABLE site_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE media_assets (id TEXT PRIMARY KEY, created_at ${pg?"BIGINT":"INTEGER"} NOT NULL, owner_id TEXT, alt TEXT, caption TEXT, variants TEXT NOT NULL, metadata TEXT);
CREATE INDEX media_assets_by_created_id ON media_assets (created_at DESC, id DESC);
CREATE INDEX media_assets_by_owner_created ON media_assets (owner_id, created_at DESC);
CREATE TABLE pending_media_uploads (id TEXT PRIMARY KEY, record TEXT NOT NULL, expires_at ${pg?"BIGINT":"INTEGER"} NOT NULL);
CREATE INDEX pending_media_uploads_expires_at ON pending_media_uploads (expires_at);
${seed}
`};
}
