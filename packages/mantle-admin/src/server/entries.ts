/** Selected Admin entry transport over generated native Views and Procedures. No schema or SQL interpreter. */
import { ContractError, type Row, type Caller } from "@aotter/mantle/contracts";
import { invalid } from "@aotter/mantle/surface";
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
    // Relationships and titles are composed by the SPA from descriptors and the same paged entries API.
    const editor = <Database>(schema: EntrySchema<Database>, row: Row) => ({ collection: schema.descriptor, entry: entry(schema, row) });
    const list = async (ctx: Context<Env, DB>) => {
        const schema = schemaOf(ctx.url.searchParams.get("collection")), q = schema.query(ctx.url.searchParams), page = q ? await nativeEntryPage(schema.binding,adapter,() => ctx.db,ctx.caller,q) : { rows: [] };
        return { items: page.rows.map(raw => entry(schema, raw)), next_cursor: page.nextCursor ?? null };
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
        return editor(schema, await current(schema, ctx, ctx.params.id!));
    };
    if (!schemas.length)
        return [];
    const ranges = { "1h": [3600000, 300000], "24h": [86400000, 3600000], "7d": [604800000, 21600000], "20d": [1728000000, 86400000] } as const;
    return [
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
        { method: "GET", path: "/entries/{id}", run: async (ctx) => { const schema = schemaOf(ctx.url.searchParams.get("collection")); return editor(schema, await current(schema, ctx, ctx.params.id!)); } },
        { method: "POST", path: "/entries", run: async (ctx) => { const raw = await json(ctx), schema = schemaOf(raw.collection); writable(schema); const data = Object.fromEntries(Object.entries(dataOf(raw)).filter(([, v]) => v !== null)), values = { ...schema.defaults, ...data }; schema.native?.(values); const checked = schema.values(schema.validate(values, !schema.publishing)); const row = await nativeEntryProcedure(schema.binding,adapter,ctx.db,ctx.caller,"create",checked); return editor(schema, row); } },
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
                    return editor(schema, row);
                const patched = await nativeEntryProcedure(schema.binding,adapter,ctx.db,ctx.caller,"patch",schema.values(data),ctx.params.id!,version);
                // RETURNING has only the child's columns; re-read so the response keeps the merged parent fields.
                return editor(schema, schema.descriptor.translates ? await current(schema, ctx, ctx.params.id!) : patched);
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
}
