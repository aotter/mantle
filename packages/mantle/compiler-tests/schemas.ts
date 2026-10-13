import type {StorageSchema} from "../src/build/core/dialect.js";
import {compileSql} from "./compiler.js";
const check=async()=>{const r=await compileSql("SELECT 1 FROM items WHERE stock >= 0",{schemas:{items:{scope:"owner",fields:{name:"text",cat:"text",stock:"integer",tags:"json",note:"text"}}},inputs:{},kind:"view"});if(!r.ok)throw Error(r.diagnostic.message);return r.plan.stmts[0]!.SelectStmt.whereClause;};
export const schemas: Record<string, StorageSchema> = {
  items: { scope: 'owner', indexes: [['owner']], ttl: 'expires_at', ttlSeconds: 3600, fields: { name: 'text', cat: 'text', stock: 'integer', tags: 'json', note: 'text', expires_at: 'timestamptz' }, checks:[await check()] },
  requisitions: { scope: 'owner', indexes: [['owner']], fields: { item_id: 'text', qty: 'integer', state: 'text' } },
  orders: { scope: 'owner', indexes: [['owner']], fields: { item_id: 'text', qty: 'integer', total: 'numeric(12,2)' } },
  settings: { scope: 'owner', fields: { key: 'text', value: 'text' }, unique: [['key']] },
  posts: { publishing: true, ttl: 'expires_at', ttlSeconds: 3600, fields: { title: 'text', body: 'text', expires_at: 'timestamptz' }, search: ['title', 'body'] },
  notes: { scope: 'owner', ttl: 'expires_at', ttlSeconds: 3600, fields: { title: 'text', body: 'text', expires_at: 'timestamptz' }, search: ['title', 'body'], unique: [['title']] },
  places: { scope: 'owner', indexes: [['owner']], ttl: 'expires_at', ttlSeconds: 3600, fields: { name: 'text', loc: 'geo', expires_at: 'timestamptz' } },
  events: { scope: 'owner', indexes: [['owner']], fields: { title: 'text', at: 'timestamptz', day: 'date', amount: 'numeric(12,2)', qty: 'integer' } },
};


export const NOW = Date.parse("2026-09-29T00:00:00Z") * 1000;
