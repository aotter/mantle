/** Selected Admin entry transport over generated native Views and Procedures. No schema or SQL interpreter. */
import { ContractError, type Target, type Row, type Caller } from "@aotter/mantle/contracts";
import { invalid } from "@aotter/mantle/surface";
import { csv } from "./csv.js";
import { json, type Context, type Route } from "./index.js";
import {exactVersion,nativeEntryGet,nativeEntryPage,nativeEntryProcedure,nativeStatistics,type NativeCollection,type NativeProcedureAdapter} from "./native.js";
export type EntryScalar = string | number | boolean;
/** Validated parameters select generated native pages; this is not a generic Store query. */
export interface EntryPageQuery {
    readonly input: Row;
    readonly order: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly match?: {
        readonly filters: Readonly<Record<string, EntryScalar | {readonly in: readonly EntryScalar[]}>>;
        readonly search?: string;
    };
}
export interface EntrySchema<Database = unknown> {
    readonly binding: NativeCollection;
    readonly transition?: (db: Database, caller: Caller, verb: "publish" | "unpublish" | "archive", id: string, expectedVersion: number | string) => Promise<unknown>;
    readonly name: string;
    readonly descriptor: Record<string, unknown>;
    readonly publishing: boolean;
    readonly primary?: boolean;
    readonly readOnly: boolean;
    /** Generated indexed fields, selected input checks and cursor validation. */
    readonly fields: Readonly<Record<string, string>>;
    readonly query: (params: URLSearchParams) => EntryPageQuery | null;
    readonly defaults: Row;
    /** Selected native transport constraints, emitted only for PostgreSQL. */
    readonly native?: (value: unknown) => void;
    readonly validate: (data: Row, full: boolean) => Row;
    readonly values: (data: Row) => Row;
    readonly row: (row: Row) => Row;
}
const fail = (message: string): never => invalid(message, "admin/entries");
const missing = () => new ContractError("NOT_FOUND", "No such entry.", "admin/entries");
const conflict = (message: string) => new ContractError("CONFLICT", message, "admin/entries");
/** Bind the OCC lock without rounding a native int8. */
const lockOf = (row: Row, expected = row.version): number | string => {
    if (!exactVersion(expected) || String(expected) !== String(row.version))
        throw conflict("The entry changed; reload it before writing.");
    return expected as number | string;
};
const native = new Set(["id", "status", "version", "createdAt", "updatedAt", "authorId", "created_at", "updated_at", "author_id", "published_at", "_rid"]);
const ms = (value: unknown) => typeof value === "number" ? value / 1000 : value == null ? null : Date.parse(String(value));
const entry = <Database>(schema: EntrySchema<Database>, raw: Row) => { const row = schema.row(raw), { id, status, version, created_at: _c, updated_at, author_id: _a, published_at: _p, ...data } = row; return { id: String(id), collection: schema.name, locale: typeof data.locale === "string" ? data.locale : null, status: status ?? null, version, data, created_at: ms(_c), updated_at: ms(updated_at) }; };
const dataOf = (raw: Record<string, unknown>) => {
    const data = raw.data ?? {};
    if (!data || typeof data !== "object" || Array.isArray(data))
        fail("data must be an object.");
    for (const key of Object.keys(data))
        if (native.has(key))
            fail(`data may not set '${key}'.`);
    return data as Row;
};
const writable = <Database>(schema: EntrySchema<Database>) => {
    if (schema.readOnly)
        throw conflict("This collection is read-only; use its declared Procedures.");
};
export function entries<Env, DB>(schemas: readonly EntrySchema<DB>[], adapter: NativeProcedureAdapter<DB>): readonly Route<Env, DB>[] {
    const collections = Object.fromEntries(schemas.map(schema => [schema.name,schema.binding]));
    const schemaOf = (name: unknown) => {
        if (typeof name !== "string" || !name)
            fail("collection naming a Schema is required.");
        const schema = schemas.find(s => s.name.toLowerCase() === (name as string).toLowerCase());
        if (!schema)
            throw new ContractError("NOT_FOUND", "No such collection.", "admin/entries");
        return schema;
    };
    const current = async (schema: EntrySchema<DB>, ctx: Context<Env, DB>, id: string) => {
        schema.native?.(id);
        const row = await nativeEntryGet(schema.binding,adapter,ctx.db,ctx.caller,id);
        if (!row)
            throw missing();
        return row;
    };
    type Descriptor = { name: string; localized?: boolean; lifecycle?: string; list?: { primaryField?: string; columns?: string[] }; schema?: { properties?: Record<string, Record<string, unknown>>; required?: string[] }; translates?: {parent: string; on: string}; parent?: {collection: string; parentField: string; childField: string} };
    const descriptor = (schema: EntrySchema<DB>) => schema.descriptor as Descriptor;
    type Entry = ReturnType<typeof entry<DB>>;
    const valueOf = (row: Entry, field: string): unknown => field === "createdAt" ? row.created_at : field === "updatedAt" ? row.updated_at : Object.hasOwn(row, field) && field !== "data" ? (row as unknown as Row)[field] : row.data[field];
    const scalar = (value: unknown): value is EntryScalar => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    const titleOf = (schema: EntrySchema<DB>, row: Entry) => {
        const d = descriptor(schema), properties = d.schema?.properties ?? {};
        const fields = [d.list?.primaryField, "title", "name", "slug", ...(d.schema?.required ?? []).filter(f => [properties[f]?.type].flat().includes("string"))];
        return fields.map(f => f ? valueOf(row, f) : null).find(v => typeof v === "string" && v !== "") ?? null;
    };
    /** A translation child's rows carry its parent's fields, so reading it also needs the parent's read. */
    const readable = async (schema: EntrySchema<DB>, ctx: Context<Env, DB>) => {
        const parent = ctx.authorize && descriptor(schema).translates?.parent;
        if (parent && !await ctx.authorize!({kind: "schema", name: parent, action: "read"})) throw new ContractError("AUTH_DENIED", "Target is not authorized.", "schema/" + parent);
    };
    const pageOf = async (schema: EntrySchema<DB>, ctx: Context<Env, DB>, params: URLSearchParams) => {
        await readable(schema, ctx);
        const q = schema.query(params);
        return q ? nativeEntryPage(schema.binding, adapter, () => ctx.db, ctx.caller, q) : {rows: [] as Row[], nextCursor: undefined};
    };
    const find = async (schema: EntrySchema<DB>, ctx: Context<Env, DB>, field: string, value: unknown, limit: number) => {
        if (!scalar(value) || value === "") return [];
        const params = new URLSearchParams({filter_field: field, filter_value: String(value), limit: String(limit)});
        return (await pageOf(schema, ctx, params)).rows.map(raw => entry(schema, raw));
    };
    /** After a committed write, related reads are best effort: a failed read must not turn a committed write into an error. */
    const editor = async (schema: EntrySchema<DB>, row: Row, ctx: Context<Env, DB>, written = false): Promise<any> => {
        const inherited = descriptor(schema).translates?.parent;
        if (ctx.authorize && (!await ctx.authorize({kind: "schema", name: schema.name, action: "read"}) || inherited && !await ctx.authorize({kind: "schema", name: inherited, action: "read"})))
            return {collection: schema.descriptor, entry: {id: row.id, version: row.version}, parentEntryId: null, parentEntryTitle: null, related: []};
        if (written) return editor(schema, row, ctx).catch(() => ({collection: schema.descriptor, entry: entry(schema, row), parentEntryId: null, parentEntryTitle: null, related: []}));
        const d = descriptor(schema), e = entry(schema, row), up = d.parent;
        const parentCandidate = up && schemas.find(s => s.name === up.collection);
        const parentSchema = parentCandidate && (!ctx.authorize || await ctx.authorize({kind:"schema",name:parentCandidate.name,action:"read"})) ? parentCandidate : undefined;
        const parent = parentSchema && (await find(parentSchema, ctx, up!.parentField, valueOf(e, up!.childField), 1))[0];
        const related = await Promise.all(schemas.flatMap(child => {
            const c = descriptor(child);
            const relations = c.translates && (c.translates.parent === schema.name || child === schema)
                ? [{kind: "translation", parentField: c.translates.on, childField: c.translates.on}]
                : child === schema ? [] : Object.entries(c.schema?.properties ?? {}).flatMap(([field, p]) => {
                    const raw = p["x-mantle-ref"];
                    const ref = typeof raw === "string" ? {schema: raw, field: "id"} : raw as {schema?: string; field?: string} | undefined;
                    return ref?.schema === schema.name ? [{kind: "field", parentField: ref.field ?? "id", childField: field}] : [];
                });
            return relations.map(async relation => {
                if (ctx.authorize && !await ctx.authorize({kind:"schema",name:child.name,action:"read"})) return undefined;
                const value = valueOf(e, relation.parentField), parentValue = scalar(value) && value !== "" ? value : null;
                return {collection: child.descriptor, relationship: {...relation, parentValue}, entries: await find(child, ctx, relation.childField, parentValue, 50)};
            });
        }));
        return {collection: schema.descriptor, entry: e, parentEntryId: parent?.id ?? null, parentEntryTitle: parent && parentSchema ? titleOf(parentSchema, parent) ?? parent.id : null, related: related.filter(Boolean)};
    };
    const list = async (ctx: Context<Env, DB>) => {
        const schema = schemaOf(ctx.url.searchParams.get("collection")), page = await pageOf(schema, ctx, ctx.url.searchParams);
        const items = page.rows.map(raw => entry(schema, raw)), locales = new Map(items.map(row => [row.id, new Set<string>()]));
        for (const child of schemas.filter(child => descriptor(child).translates?.parent === schema.name && descriptor(child).localized)) {
            if (ctx.authorize && !await ctx.authorize({kind:"schema",name:child.name,action:"read"})) continue;
            const on = descriptor(child).translates!.on, byKey = new Map<unknown, Set<string>>();
            const keys = [...new Set(items.map(row => valueOf(row, on)).filter(v => scalar(v) && v !== ""))];
            for (let offset = 0; offset < keys.length; offset += 50) {
                const params = new URLSearchParams({filter_field: on, filter_values: JSON.stringify(keys.slice(offset, offset + 50)), limit: "500"});
                for (;;) {
                    const translations = await pageOf(child, ctx, params);
                    for (const raw of translations.rows) {
                        const row = entry(child, raw), key = valueOf(row, on);
                        if (row.locale) byKey.set(key, (byKey.get(key) ?? new Set()).add(row.locale));
                    }
                    if (!translations.nextCursor) break;
                    params.set("cursor", translations.nextCursor);
                }
            }
            for (const row of items) for (const locale of byKey.get(valueOf(row, on)) ?? []) locales.get(row.id)!.add(locale);
        }
        const d = descriptor(schema), preview = [...(d.list?.primaryField ? [d.list.primaryField] : []), ...(d.list?.columns ?? [])];
        return {items: items.map(row => ({...row, title: schema.publishing ? titleOf(schema, row) : null, translation_locales: [...locales.get(row.id)!], ...(!schema.publishing && preview.length ? {data_preview: Object.fromEntries(preview.map(f => [f, valueOf(row, f) ?? null]))} : {})})), next_cursor: page.nextCursor ?? null};
    };
    const move = (verb: "publish" | "unpublish" | "archive") => async (ctx: Context<Env, DB>) => {
        const schema = schemaOf(ctx.url.searchParams.get("collection"));
        writable(schema);
        if (!schema.publishing)
            throw conflict("Only publishing collections have transitions.");
        const raw = await json(ctx), expected = raw.expectedVersion;
        if (expected !== undefined && !exactVersion(expected))
            fail("Invalid expectedVersion.");
        const row = await current(schema, ctx, ctx.params.id!);
        const lock = lockOf(row, expected ?? row.version);
        if (verb === "publish")
            schema.validate(Object.fromEntries(Object.entries(entry(schema, row).data).filter(([key]) => Object.hasOwn(schema.fields, key))), true);
        await schema.transition!(ctx.db, ctx.caller, verb, ctx.params.id!, lock);
        return editor(schema, await current(schema, ctx, ctx.params.id!), ctx, true);
    };
    if (!schemas.length)
        return [];
    const ranges = { "1h": [3600000, 300000], "24h": [86400000, 3600000], "7d": [604800000, 21600000], "20d": [1728000000, 86400000] } as const;
    const routes: readonly Route<Env, DB>[] = [
        ...(schemas.some(s => s.primary && s.binding.statistics) ? [{ method: "GET", path: "/collections/{name}/statistics", run: async (ctx: Context<Env, DB>) => {
                    const schema = schemaOf(ctx.params.name);
                    if (!schema.primary)
                        throw new ContractError("NOT_FOUND", "No such primary collection.", "admin/statistics");
                    const range = ctx.url.searchParams.get("range") ?? "7d";
                    if (!Object.hasOwn(ranges, range))
                        fail("Invalid statistics range.");
                    if (!schema.binding.statistics)
                        throw new ContractError("STATISTICS_UNAVAILABLE", "Statistics are unavailable for this storage adapter.", "admin/statistics", { status: 501 });
                    const [duration, bucketMs] = ranges[range as keyof typeof ranges], to = Date.now(), from = to - duration;
                    return { ...await nativeStatistics(collections,adapter,ctx.db,ctx.caller,schema.name,{from,to,bucketMs}), from, to, bucketMs };
                } }] : []),
        { method: "GET", path: "/entries", run: list },
        { method: "GET", path: "/entries/export", run: async ctx => {
            const schema = schemaOf(ctx.url.searchParams.get("collection"));
            const params = new URLSearchParams(ctx.url.searchParams);
            params.delete("cursor"); params.set("limit", "500");
            const columns = ["id", ...(schema.publishing ? ["status"] : []), "version", "updated_at", ...(schema.descriptor.exportFields as readonly string[] ?? [])];
            return csv(schema.name, async cursor => {
                if (cursor) params.set("cursor", cursor); else params.delete("cursor");
                const page = await pageOf(schema, ctx, params);
                return {...page, rows: page.rows.map(schema.row)};
            }, columns);
        } },
        { method: "GET", path: "/entries/{id}", run: async (ctx) => { const schema = schemaOf(ctx.url.searchParams.get("collection")); return editor(schema, await current(schema, ctx, ctx.params.id!), ctx); } },
        { method: "POST", path: "/entries", run: async (ctx) => { const raw = await json(ctx), schema = schemaOf(raw.collection); writable(schema); const data = Object.fromEntries(Object.entries(dataOf(raw)).filter(([, v]) => v !== null)), values = { ...schema.defaults, ...data }; schema.native?.(values); const checked = schema.values(schema.validate(values, !schema.publishing)); const row = await nativeEntryProcedure(schema.binding,adapter,ctx.db,ctx.caller,"create",checked); return editor(schema, row, ctx, true); } },
        { method: "PATCH", path: "/entries/{id}", run: async (ctx) => {
                const schema = schemaOf(ctx.url.searchParams.get("collection"));
                writable(schema);
                const raw = await json(ctx), patch = dataOf(raw), lock = raw.expectedVersion;
                schema.native?.(patch);
                if (!exactVersion(lock))
                    fail("expectedVersion is required.");
                const row = await current(schema, ctx, ctx.params.id!);
                if (schema.publishing && row.status !== "draft")
                    throw conflict("Only drafts may be edited.");
                // Translation reads merge the parent's fields into data; an unchanged echo of one is a no-op, a changed one still fails as unknown.
                const existing = entry(schema, row).data, data = Object.fromEntries(Object.entries(patch).filter(([key, value]) => Object.hasOwn(schema.fields, key) ? value !== null || existing[key] != null : !(Object.hasOwn(existing, key) && JSON.stringify(existing[key]) === JSON.stringify(value))));
                schema.validate(data, false);
                const version = lockOf(row, lock);
                if (!Object.keys(data).length)
                    return editor(schema, row, ctx, true);
                const patched = await nativeEntryProcedure(schema.binding,adapter,ctx.db,ctx.caller,"patch",schema.values(data),ctx.params.id!,version);
                // RETURNING has only the child's columns; re-read so the response keeps the merged parent fields.
                return editor(schema, schema.descriptor.translates ? await current(schema, ctx, ctx.params.id!) : patched, ctx, true);
            } },
        { method: "POST", path: "/entries/{id}/publish", run: move("publish") }, { method: "POST", path: "/entries/{id}/unpublish", run: move("unpublish") }, { method: "POST", path: "/entries/{id}/archive", run: move("archive") },
        { method: "DELETE", path: "/entries/{id}", run: async (ctx) => {
                const schema = schemaOf(ctx.url.searchParams.get("collection"));
                writable(schema);
                const row = await current(schema, ctx, ctx.params.id!);
                if (schema.publishing && row.status === "published")
                    throw conflict("Published entries must be unpublished before deletion.");
                await nativeEntryProcedure(schema.binding,adapter,ctx.db,ctx.caller,"remove",{},ctx.params.id!,lockOf(row));
                return { affected: 1 };
            } },
    ];
    return routes.map(route => ({...route, target: ctx => {
        const schema = schemaOf(route.path.startsWith("/collections/") ? ctx.params.name : route.method === "POST" && route.path === "/entries" ? ctx.input?.collection : ctx.url.searchParams.get("collection"));
        if (route.path.endsWith("/publish") || route.path.endsWith("/unpublish") || route.path.endsWith("/archive")) return {kind:"procedure",name:schema.name + "." + route.path.split("/").at(-1)};
        const action: Target["action"] = route.method === "GET" ? "read" : route.method === "POST" ? "create" : route.method === "PATCH" ? "update" : "delete";
        return {kind:"schema",name:schema.name,action};
    }}));
}
