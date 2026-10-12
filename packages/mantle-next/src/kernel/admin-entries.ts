/** Selected Admin entry transport over native collections. No schema or SQL interpreter. */
import { ContractError, type Row } from "./contracts.js";
import { invalid } from "./surface.js";
import { body, csv, type Context, type Route } from "./admin.js";
import { decodeCursor, type Query } from "./store.js";
type Collection = {
    find(query?: Query<object, string>): Promise<{
        rows: readonly Row[];
        cursor: string | null;
    }>;
    findById(id: string): Promise<Row | null>;
    insert(data: Row): PromiseLike<Row>;
    update(id: string, data: Row, options: {
        lock: number;
    }): PromiseLike<Row>;
    delete(id: string, options: {
        lock: number;
    }): PromiseLike<void>;
};
export interface EntriesStore {
    collection(name: string): Collection;
    procedures: Record<string, (input: never) => Promise<unknown>>;
}
export interface EntrySchema {
    readonly name: string;
    readonly descriptor: Record<string, unknown>;
    readonly publishing: boolean;
    readonly readOnly: boolean;
    /** Literal maps and functions produced at build time, never a JSON Schema validator. */
    readonly fields: Readonly<Record<string, string>>;
    readonly filters: Readonly<Record<string, (value: string) => unknown>>;
    readonly sortable: Readonly<Record<string, string>>;
    readonly idOrder?: "asc";
    readonly nulls: (column: string, ascending: boolean) => "first" | "last" | undefined;
    readonly cursor: (column: string, value: unknown) => boolean;
    readonly preview: readonly string[];
    readonly titles: readonly string[];
    readonly csv: readonly string[];
    readonly parent?: {
        collection: string;
        parentField: string;
        childField: string;
    };
    readonly related: readonly {
        collection: string;
        kind: string;
        parentField: string;
        childField: string;
    }[];
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
/** Tie the transport lock to the policy-checked row without rounding a PostgreSQL int8. */
const lockOf = (row: Row, expected = Number(row.version)): number => {
    if (!Number.isSafeInteger(expected) || String(expected) !== String(row.version))
        throw conflict("The entry changed; reload it before writing.");
    return expected;
};
const native = new Set(["id", "status", "version", "createdAt", "updatedAt", "authorId", "created_at", "updated_at", "author_id", "published_at", "_rid"]);
const ms = (value: unknown) => typeof value === "number" ? value / 1000 : value == null ? null : Date.parse(String(value));
const title = (schema: EntrySchema, row: Row) => schema.titles.map(key => row[key]).find(value => typeof value === "string" && value !== "") ?? null;
const entry = (schema: EntrySchema, raw: Row) => { const row = schema.row(raw), { id, status, version, created_at: _c, updated_at, author_id: _a, published_at: _p, ...data } = row; return { id: String(id), collection: schema.name, locale: typeof data.locale === "string" ? data.locale : null, status: status ?? null, version, data, updated_at: ms(updated_at) }; };
const dataOf = (raw: Record<string, unknown>) => {
    const data = raw.data ?? {};
    if (!data || typeof data !== "object" || Array.isArray(data))
        fail("data must be an object.");
    for (const key of Object.keys(data))
        if (native.has(key))
            fail(`data may not set '${key}'.`);
    return data as Row;
};
const writable = (schema: EntrySchema) => {
    if (schema.readOnly)
        throw conflict("This collection is read-only; use its declared Procedures.");
};
const query = (schema: EntrySchema, params: URLSearchParams): Query<object, string> | null => {
    if (params.get("cursor_direction") === "backward")
        fail("Entries page forward only; retain previous cursors.");
    const where: Row = Object.create(null), seen = new Map<string, unknown>();
    let satisfiable = true;
    const add = (field: string, value: unknown) => {
        if (seen.has(field) && !Object.is(seen.get(field), value))
            satisfiable = false;
        seen.set(field, value);
        where[field] = value;
    };
    const status = params.get("status");
    if (schema.publishing && status && status !== "all")
        add("status", status);
    for (const prefix of ["filter", "scope"]) {
        const field = params.get(prefix + "_field"), value = params.get(prefix + "_value");
        if (!field !== !value)
            fail(prefix + "_field and " + prefix + "_value go together.");
        if (field) {
            const coerce = Object.hasOwn(schema.filters, field) ? schema.filters[field] : undefined;
            if (!coerce)
                fail("Unknown filter field.");
            add(schema.fields[field] ?? field, coerce!(value!));
        }
    }
    if (!satisfiable)
        return null;
    const sort = params.get("sort") || "updatedAt", orderBy = Object.hasOwn(schema.sortable, sort) ? schema.sortable[sort] : undefined;
    if (!orderBy)
        fail("Sort must name an indexed NOT NULL field.");
    const cursor = params.get("cursor");
    if (cursor) {
        const [value, id] = decodeCursor(cursor, "admin/entries/cursor");
        schema.native?.(value);
        schema.native?.(id);
        if (typeof id !== "string" || !id || !schema.cursor(orderBy!, value))
            fail("Invalid cursor for this sort.");
    }
    const limit = params.get("limit");
    let count: number | undefined;
    if (limit !== null) {
        count = Number(limit);
        if (!limit.trim() || !Number.isSafeInteger(count) || count < 1 || count > 500)
            fail("limit must be an integer from 1 to 500.");
    }
    const search = params.get("search")?.trim();
    if (search?.includes("\0"))
        fail("Search must not contain NUL.");
    return { where, orderBy, ...(orderBy !== "id" && schema.idOrder ? { idOrder: schema.idOrder } : {}), order: params.get("direction") === "asc" ? "asc" : "desc", nulls: schema.nulls(orderBy!, params.get("direction") === "asc"), ...(count === undefined ? {} : { limit: count }), ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}), ...(search ? { search } : {}) };
};
export function entries<Env, DB>(schemas: readonly EntrySchema[], storeFor: (db: DB, caller: Context<Env, DB>["caller"]) => EntriesStore, locales?: (db: DB, caller: Context<Env, DB>["caller"], name: string, rows: readonly Row[]) => Promise<Record<string, string[]>>): readonly Route<Env, DB>[] {
    const schemaOf = (name: unknown) => {
        if (typeof name !== "string" || !name)
            fail("collection naming a Schema is required.");
        const schema = schemas.find(s => s.name.toLowerCase() === (name as string).toLowerCase());
        if (!schema)
            throw new ContractError("NOT_FOUND", "No such collection.", "admin/entries");
        return schema;
    };
    const current = async (store: EntriesStore, schema: EntrySchema, id: string) => {
        schema.native?.(id);
        const row = await store.collection(schema.name).findById(id);
        if (!row)
            throw missing();
        return row;
    };
    const editor = async (store: EntriesStore, schema: EntrySchema, row: Row) => {
        const decoded = schema.row(row), up = schema.parent, value = up && decoded[up.childField], parentSchema = up && value != null && value !== "" ? schemaOf(up.collection) : undefined;
        const parent = parentSchema ? (await store.collection(parentSchema.name).find({ where: { [parentSchema.fields[up!.parentField] ?? up!.parentField]: value }, limit: 1 })).rows[0] : undefined;
        const related = await Promise.all(schema.related.map(async (relation) => { const child = schemaOf(relation.collection), value = decoded[relation.parentField], rows = value == null || value === "" ? [] : (await store.collection(child.name).find({ where: { [child.fields[relation.childField] ?? relation.childField]: value }, limit: 50 })).rows; return { collection: child.descriptor, relationship: { kind: relation.kind, parentField: relation.parentField, childField: relation.childField, parentValue: value ?? null }, entries: rows.map(row => entry(child, row)) }; }));
        return { collection: schema.descriptor, entry: entry(schema, row), parentEntryId: parent ? String(parent.id) : null, parentEntryTitle: parent ? title(parentSchema!, parentSchema!.row(parent)) ?? String(parent.id) : null, related };
    };
    const list = async (ctx: Context<Env, DB>) => {
        const schema = schemaOf(ctx.url.searchParams.get("collection")), store = storeFor(ctx.db, ctx.caller), q = query(schema, ctx.url.searchParams), page = q ? await store.collection(schema.name).find(q) : { rows: [], cursor: null };
        const translations = locales && page.rows.length ? await locales(ctx.db, ctx.caller, schema.name, page.rows) : {};
        return { items: page.rows.map(raw => { const e = entry(schema, raw); return { id: e.id, collection: schema.name, locale: e.locale, status: e.status, version: e.version, title: schema.publishing ? title(schema, e.data) : null, updated_at: e.updated_at, translation_locales: translations[e.id] ?? [], ...(!schema.publishing && schema.preview.length ? { data_preview: Object.fromEntries(schema.preview.map(key => [key, e.data[key] ?? null])) } : {}) }; }), next_cursor: page.cursor };
    };
    const move = (verb: "publish" | "unpublish") => async (ctx: Context<Env, DB>) => {
        const schema = schemaOf(ctx.url.searchParams.get("collection"));
        writable(schema);
        if (!schema.publishing)
            throw conflict("Only publishing collections have transitions.");
        const store = storeFor(ctx.db, ctx.caller), row = await current(store, schema, ctx.params.id!);
        if (verb === "publish")
            schema.validate(Object.fromEntries(Object.entries(entry(schema, row).data).filter(([key]) => Object.hasOwn(schema.fields, key))), true);
        await store.procedures[schema.name + "." + verb]!({ id: ctx.params.id!, expectedVersion: lockOf(row) } as never);
        return editor(store, schema, await current(store, schema, ctx.params.id!));
    };
    return [
        { method: "GET", path: "/entries", run: list },
        { method: "GET", path: "/entries/export", run: async (ctx) => {
                const schema = schemaOf(ctx.url.searchParams.get("collection")), store = storeFor(ctx.db, ctx.caller), q = query(schema, ctx.url.searchParams);
                return csv(schema.name, async (cursor) => {
                    if (!q)
                        return { rows: [] };
                    const page = await store.collection(schema.name).find({ ...q, limit: 500, cursor });
                    return { rows: page.rows.map(raw => { const e = entry(schema, raw); return { id: e.id, ...(schema.publishing ? { status: e.status } : {}), version: e.version, updated_at: e.updated_at, ...e.data }; }), ...(page.cursor ? { nextCursor: page.cursor } : {}) };
                }, schema.csv);
            } },
        { method: "GET", path: "/entries/{id}", run: async (ctx) => { const schema = schemaOf(ctx.url.searchParams.get("collection")), store = storeFor(ctx.db, ctx.caller); return editor(store, schema, await current(store, schema, ctx.params.id!)); } },
        { method: "POST", path: "/entries", run: async (ctx) => { const raw = await body(ctx.request), schema = schemaOf(raw.collection); writable(schema); const store = storeFor(ctx.db, ctx.caller), data = Object.fromEntries(Object.entries(dataOf(raw)).filter(([, v]) => v !== null)); const values = { ...schema.defaults, ...data }; schema.native?.(values); const row = await store.collection(schema.name).insert(schema.values(schema.validate(values, !schema.publishing))); return editor(store, schema, row); } },
        { method: "PATCH", path: "/entries/{id}", run: async (ctx) => {
                const schema = schemaOf(ctx.url.searchParams.get("collection"));
                writable(schema);
                const store = storeFor(ctx.db, ctx.caller), early = schema.native ? await body(ctx.request) : undefined;
                if (early)
                    schema.native!(dataOf(early));
                const row = await current(store, schema, ctx.params.id!), raw = early ?? await body(ctx.request), lock = raw.expectedVersion;
                if (typeof lock !== "number" || !Number.isSafeInteger(lock) || lock < 0)
                    fail("expectedVersion is required.");
                if (schema.publishing && row.status !== "draft")
                    throw conflict("Only drafts may be edited.");
                const existing = entry(schema, row).data, data = Object.fromEntries(Object.entries(dataOf(raw)).filter(([key, value]) => value !== null || existing[key] != null));
                schema.validate(data, false);
                if (Object.keys(data).length)
                    await store.collection(schema.name).update(ctx.params.id!, schema.values(data), { lock: lockOf(row, lock as number) });
                return editor(store, schema, await current(store, schema, ctx.params.id!));
            } },
        { method: "POST", path: "/entries/{id}/publish", run: move("publish") }, { method: "POST", path: "/entries/{id}/unpublish", run: move("unpublish") },
        { method: "DELETE", path: "/entries/{id}", run: async (ctx) => {
                const schema = schemaOf(ctx.url.searchParams.get("collection"));
                writable(schema);
                const store = storeFor(ctx.db, ctx.caller), row = await current(store, schema, ctx.params.id!);
                if (schema.publishing && row.status === "published")
                    throw conflict("Published entries must be unpublished before deletion.");
                await store.collection(schema.name).delete(ctx.params.id!, { lock: lockOf(row) });
                return { affected: 1 };
            } },
    ];
}
