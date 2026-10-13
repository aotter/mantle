/** Selected generated native adapters: constants and compiled predicates, never a manifest interpreter. */
import { ContractError, deny, type Caller, type Row } from "@aotter/mantle/contracts";
import { binds, bound, type Recipe, type Step, type Bound, type Values } from "@aotter/mantle/binds";
import { query as readQuery } from "@aotter/mantle/validation";
import { invalid } from "@aotter/mantle/surface";
import { page, decodeNullableCursor, encodeCursor, validCursor, type CursorKind, type Pages } from "@aotter/mantle/paging";
import type {EntryPageQuery, EntryScalar} from "./entries.js";
export interface NativeAdapter<Database> {
    readonly read: (db: Database, sql: string, values: unknown[]) => PromiseLike<Row[]> | Row[];
    readonly values: Values;
    readonly param: (n: number) => string;
    readonly escapeLike: (s: string) => string;
    readonly sqlite: boolean;
}
export async function nativeStatistics<Database>(specs: Readonly<Record<string, NativeCollection>>, adapter: NativeAdapter<Database>, db: Database, caller: Caller, collection: string, args: {from: number; to: number; bucketMs: number}) {
    deny(caller, caller.kind === "user" && caller.role === "staff", "admin/statistics");
    if (!Object.hasOwn(specs, collection)) invalid("Unknown collection.", "admin/statistics");
    const spec = specs[collection]!, {from, to, bucketMs} = args;
    if (!spec.statistics || ![from, to, bucketMs].every(Number.isSafeInteger) || from < 0 || to <= from || bucketMs <= 0 || to - from > 20 * 86400000 || Math.ceil((to - from) / bucketMs) > 480 || Math.max(to, bucketMs) > Number.MAX_SAFE_INTEGER / 1000) invalid("Statistics require <=20 days and <=480 buckets.", "admin/statistics");
    const m = spec.caller, values = binds(adapter.values, m.binds, caller);
    const parameter = (value: unknown) => {values.push(value); return adapter.param(values.length);};
    const lower = parameter(from * 1000), upper = parameter(to * 1000), width = parameter(bucketMs * 1000);
    const source = `SELECT ${spec.statistics.time} AS _time, ${spec.statistics.subtype} AS _subtype ${m.from}${m.policy ? " WHERE (" + m.policy + ")" : ""}`;
    const division = `((_time - ${lower}) / ${width})`, bucket = adapter.sqlite ? `CAST(${division} AS INTEGER)` : `CAST(floor(${division}) AS bigint)`;
    const rowsAlias = spec.statistics.rowsAlias.sql;
    const rows = await adapter.read(db, `WITH ${rowsAlias} AS (${source}) SELECT -1 AS bucket, NULL AS subtype, count(*) AS count FROM ${rowsAlias} UNION ALL SELECT ${bucket} AS bucket, _subtype AS subtype, count(*) AS count FROM ${rowsAlias} WHERE _time >= ${lower} AND _time < ${upper} GROUP BY ${bucket}, _subtype ORDER BY bucket, subtype`, values);
    let total = 0;
    const buckets: {bucket: number; subtype: string | null; count: number}[] = [];
    for (const row of rows) {
        if (Number(row.bucket) === -1) total = Number(row.count);
        else buckets.push({bucket: Number(row.bucket), subtype: row.subtype == null ? null : String(row.subtype), count: Number(row.count)});
    }
    return {total, buckets};
}
export function nativeText(value: unknown): void {
    const pending = [value];
    while (pending.length) {
        const item = pending.pop();
        if (typeof item === "string" && item.includes("\0"))
            invalid("PostgreSQL text and JSON must not contain NUL.", "admin/input");
        if (item && typeof item === "object")
            for (const [key, child] of Object.entries(item))
                pending.push(key, child);
    }
}
export function scalarNumber(raw: string, integer: boolean, path: string): number {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || integer && !Number.isSafeInteger(n))
        invalid("Expected a finite, safe number.", path);
    return n;
}
export type NativePageMode = {
    marker: string;
    binds: readonly Recipe[];
    keys: number;
    first: {
        prefix: string;
        extra: readonly number[];
    };
    next?: {
        prefix: string;
        extra: readonly number[];
    };
    tail: string;
    eq: Readonly<Record<string, string>>;
    search?: string;
};
export async function nativePage<Database>(spec: {
    path: string;
    cap: number;
    cursorKinds: readonly CursorKind[];
    caller: NativePageMode;
    trusted: NativePageMode;
}, adapter: NativeAdapter<Database>, db: Database, caller: Caller, input: Record<string, unknown>, options: {
    limit?: number;
    cursor?: string;
    match?: Record<string, unknown>;
}) {
    const m = caller.kind === "system" ? spec.trusted : spec.caller;
    const match = options.match as {
        search?: string;
        filters?: Record<string, string | number | boolean>;
    } | undefined;
    const filters = match?.filters ?? {}, search = match?.search;
    const operation = JSON.stringify([spec.path, caller, input, filters, search ?? null]);
    const fragments: string[] = [], filterValues: unknown[] = [];
    for (const [field, value] of Object.entries(filters)) {
        if (!Object.hasOwn(m.eq, field))
            invalid("Unknown View filter.", spec.path);
        fragments.push(m.eq[field]!);
        filterValues.push(value);
    }
    if (search) {
        if (!m.search || search.includes("\0") || new TextEncoder().encode(search).byteLength > 1024)
            invalid("Invalid View search.", spec.path);
        fragments.push(m.search);
        filterValues.push("%" + adapter.escapeLike(search) + "%");
    }
    const compiled = (p: NativePageMode["first"], next: boolean): Pages["first"] => {
        const count = m.binds.length + p.extra.length;
        const predicates = fragments.map((fragment, i) => "(" + fragment.replaceAll(m.marker, adapter.param(count + i + 1)) + ")");
        const suffix = predicates.length ? (next ? " AND " : " WHERE ") + predicates.join(" AND ") : "";
        return { sql: p.prefix + suffix + m.tail.replaceAll(m.marker, adapter.param(count + filterValues.length + 1)), extra: [...p.extra, -1] };
    };
    try {
        return await page<Database, Row>({
            path: operation, cap: spec.cap, sqlite: adapter.sqlite, cursor: spec.cursorKinds, keys: m.keys,
            values: adapter.values,
            caller: { binds: m.binds, first: compiled(m.first, false), next: compiled(m.next ?? m.first, true) },
            read: (database, sql, values) => adapter.read(database, sql, [...values.slice(0, -1), ...filterValues, values.at(-1)])
        }, db, caller, input, options);
    }
    catch (error) {
        // The cursor tag includes authority and selected filters; public diagnostics retain the route path.
        if (error instanceof ContractError && error.code === "INPUT_VALIDATION_FAILED" && (error.path === operation || error.path.startsWith(operation + "/")))
            throw new ContractError(error.code, error.message, spec.path + error.path.slice(operation.length), { status: error.status, fields: error.fields, cause: error });
        throw error;
    }
}
/** An OCC value must retain the exact native int8; a rounded number is never a lock. */
export const exactVersion = (value: unknown): value is number | string => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 || typeof value === "string" && value.length <= 19 && /^(?:0|[1-9]\d*)$/.test(value) && BigInt(value) <= 9223372036854775807n;
/** Constant procedure fragments and recipes are printed by Core; the app supplies only checked values. */
export interface NativeEntryMode {
    readonly projection: string;
    readonly from: string;
    readonly policy: string;
    readonly binds: readonly Recipe[];
    readonly fields: Readonly<Record<string, {readonly column: string; readonly insert: string; readonly update: string}>>;
    readonly create: {readonly prefix: string; readonly between: string; readonly suffix: string; readonly binds: readonly Recipe[]; readonly columns: readonly string[]; readonly values: readonly string[]; readonly returning: string};
    readonly patch: {readonly prefix: string; readonly binds: readonly Recipe[]; readonly sets: readonly string[]; readonly where: string; readonly returning: string};
    readonly remove: Step;
}
export interface NativeEntryProcedures {
    readonly path: string;
    readonly marker: string;
    readonly scoped?: boolean;
    readonly caller: NativeEntryMode;
    readonly trusted: NativeEntryMode;
}
export interface NativeProcedureAdapter<Database> extends NativeAdapter<Database> {
    readonly procedure: (db: Database, steps: readonly Bound[], path: string) => Promise<Row[][]>;
}
export interface NativeCollection extends NativeEntryProcedures {
    readonly id: string;
    readonly cursorAliases: readonly [{readonly name: string; readonly sql: string}, {readonly name: string; readonly sql: string}];
    readonly fields: Readonly<Record<string, {readonly expression: string; readonly value: string; readonly wire: string; readonly kind?: CursorKind; readonly nullable: boolean}>>;
    readonly orderFields: readonly string[];
    readonly search?: string;
    readonly statistics?: {readonly time: string; readonly subtype: string; readonly rowsAlias: {readonly name: string; readonly sql: string}};
}
export async function nativeEntryGet<Database>(spec: NativeCollection, adapter: NativeAdapter<Database>, db: Database, caller: Caller, id: string): Promise<Row | null> {
    if (typeof id !== "string" || !id) invalid("An entry id is required.", spec.path);
    if (!adapter.sqlite) nativeText(id);
    const m = caller.kind === "system" ? spec.trusted : spec.caller, values = binds(adapter.values, m.binds, caller);
    values.push(id);
    const where = [m.policy, `${spec.id} = ${adapter.param(values.length)}`].filter(Boolean).map(term => "(" + term + ")").join(" AND ");
    return (await adapter.read(db, `SELECT ${m.projection} ${m.from} WHERE ${where} LIMIT 1`, values))[0] ?? null;
}
export async function nativeEntryProcedure<Database>(spec: NativeEntryProcedures, adapter: NativeProcedureAdapter<Database>, db: Database, caller: Caller, verb: "create", data: Row, id?: string, version?: number | string): Promise<Row>;
export async function nativeEntryProcedure<Database>(spec: NativeEntryProcedures, adapter: NativeProcedureAdapter<Database>, db: Database, caller: Caller, verb: "patch", data: Row, id: string, version: number | string): Promise<Row>;
export async function nativeEntryProcedure<Database>(spec: NativeEntryProcedures, adapter: NativeProcedureAdapter<Database>, db: Database, caller: Caller, verb: "remove", data: Row, id: string, version: number | string): Promise<void>;
export async function nativeEntryProcedure<Database>(spec: NativeEntryProcedures, adapter: NativeProcedureAdapter<Database>, db: Database, caller: Caller, verb: "create" | "patch" | "remove", data: Row, id?: string, version?: number | string): Promise<Row | void> {
    const m = caller.kind === "system" ? spec.trusted : spec.caller, context = {id, version};
    if (verb === "create" && spec.scoped && caller.kind === "anonymous") throw new ContractError("UNAUTHENTICATED", "A scoped insert requires an authenticated caller.", spec.path);
    if (verb !== "create" && (typeof id !== "string" || !id || !exactVersion(version))) invalid("An id and exact version are required.", spec.path);
    if (!adapter.sqlite) {nativeText(context); nativeText(data);}
    if (verb === "remove") {
        await adapter.procedure(db, bound(adapter.values, [m.remove], caller, context), spec.path);
        return;
    }
    const present = Object.entries(data).map(([field, value]) => {
        if (!Object.hasOwn(m.fields, field) || value === undefined) invalid("Unknown writable field or missing value.", spec.path);
        return {fragment: m.fields[field]!, value};
    });
    const c = verb === "create" ? m.create : m.patch;
    const values = binds(adapter.values, c.binds, caller, context);
    const fragments = present.map(({fragment, value}) => {
        values.push(value);
        return (verb === "create" ? fragment.insert : fragment.update).replaceAll(spec.marker, adapter.param(values.length));
    });
    const sql = verb === "create"
        ? m.create.prefix + [...m.create.columns, ...present.map(({fragment}) => fragment.column)].join(", ") + m.create.between + [...m.create.values, ...fragments].join(", ") + m.create.suffix + m.create.returning
        : m.patch.prefix + [...m.patch.sets, ...fragments].join(", ") + m.patch.where + m.patch.returning;
    const result = await adapter.procedure(db, [{sql, binds: values, row: true}], spec.path);
    return result[0]![0]!;
}
/** Fixed indexed keyset templates bind values; identifiers and Core policy come only from the compiled whitelist. */
export async function nativeEntryPage<Database>(spec: NativeCollection, adapter: NativeAdapter<Database>, getDb: () => Database, caller: Caller, query: EntryPageQuery) {
    const match = /^(.*):(asc|desc)$/.exec(query.order), column = match?.[1], direction = match?.[2];
    if (!column || !Object.hasOwn(spec.fields, column) || !spec.orderFields.includes(column)) invalid("Unknown indexed order.", spec.path);
    const field = spec.fields[column]!;
    if (!field.kind) invalid("Unknown cursor type.", spec.path);
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) invalid("limit is 1 to 500.", spec.path);
    const m = caller.kind === "system" ? spec.trusted : spec.caller, filters = query.match?.filters ?? {}, search = query.match?.search;
    const operation = JSON.stringify([spec.path, caller, query.input, filters, search ?? null, query.order]);
    const cursor = query.cursor === undefined ? undefined : decodeNullableCursor(query.cursor, spec.path + "/cursor", operation);
    if (!adapter.sqlite) {nativeText(query.input); nativeText(filters); nativeText(cursor);}
    if (cursor && (field.expression === spec.id && cursor[0] !== cursor[1] || (cursor[0] === null ? !field.nullable : !validCursor(field.kind, adapter.sqlite, cursor[0])))) invalid("Malformed or wrongly typed cursor.", spec.path + "/cursor");
    let value = cursor?.[0];
    if (cursor && value !== null && (field.kind === "date" || field.kind === "timestamp")) {
        try {value = adapter.values[field.kind]!(value as string);} catch {invalid("Malformed temporal cursor.", spec.path + "/cursor");}
    }
    const values = binds(adapter.values, m.binds, caller, query.input), predicates = m.policy ? ["(" + m.policy + ")"] : [];
    const parameter = (value: unknown) => {values.push(value); return adapter.param(values.length);};
    const input = (selected: NativeCollection["fields"][string], value: unknown) => selected.value.replaceAll(spec.marker, parameter(value));
    for (const [name, filter] of Object.entries(filters)) {
        if (!Object.hasOwn(spec.fields, name)) invalid("Unknown entry filter.", spec.path);
        const selected = spec.fields[name]!, many = filter !== null && typeof filter === "object" && !Array.isArray(filter), items = many ? filter.in : [filter];
        if (!Array.isArray(items) || !items.length || items.length > 50 || items.some(item => !["string", "number", "boolean"].includes(typeof item) || typeof item === "number" && !Number.isFinite(item))) invalid("Invalid entry filter values.", spec.path);
        predicates.push(many ? `${selected.expression} IN (${items.map(value => input(selected,value)).join(", ")})` : `${selected.expression} = ${input(selected,items[0])}`);
    }
    if (search) {
        if (!spec.search || search.includes("\0") || new TextEncoder().encode(search).byteLength > 1024) invalid("Invalid entry search.", spec.path);
        predicates.push("(" + spec.search.replaceAll(spec.marker, parameter(search)) + ")");
    }
    const ascending = direction === "asc", idAscending = adapter.sqlite || ascending, nullsFirst = adapter.sqlite ? ascending : !ascending;
    if (cursor) {
        const id = parameter(cursor[1]), compare = ascending ? ">" : "<", idCompare = idAscending ? ">" : "<";
        if (cursor[0] === null) predicates.push(`(${field.expression} IS NULL AND ${spec.id} ${idCompare} ${id}${nullsFirst ? " OR " + field.expression + " IS NOT NULL" : ""})`);
        else {
            const key = input(field, value);
            const nullTail = field.nullable && !nullsFirst ? " OR " + field.expression + " IS NULL" : "";
            predicates.push(`((${field.expression} ${compare}= ${key}${nullTail}) AND (${field.expression} ${compare} ${key} OR (${field.expression} = ${key} AND ${spec.id} ${idCompare} ${id})${nullTail}))`);
        }
    }
    const size = parameter(limit + 1), where = predicates.length ? " WHERE " + predicates.map(term => "(" + term + ")").join(" AND ") : "";
    const order = `${field.expression} ${ascending ? "ASC" : "DESC"} NULLS ${nullsFirst ? "FIRST" : "LAST"}, ${spec.id} ${idAscending ? "ASC" : "DESC"}`;
    const [keyAlias,idAlias] = spec.cursorAliases;
    const rows = await adapter.read(getDb(), `SELECT ${m.projection}, ${field.wire} AS ${keyAlias.sql}, ${spec.id} AS ${idAlias.sql} ${m.from}${where} ORDER BY ${order} LIMIT ${size}`, values);
    const last = rows[limit - 1], nextCursor = rows.length > limit && last ? encodeCursor(last[keyAlias.name], last[idAlias.name], operation) : undefined;
    if (rows.length > limit) rows.length = limit;
    for (const row of rows) {delete row[keyAlias.name]; delete row[idAlias.name];}
    return {rows, ...(nextCursor ? {nextCursor} : {})};
}
/** Shared URL assembly; each field's coercion and checks are compiled application callbacks. */
export function entriesQuery(params: URLSearchParams, options: {
    path: string;
    orderFields: Readonly<Record<string, string>>;
    publishing: boolean;
    sqlite: boolean;
    field: (name: string, raw: string) => {
        column: string;
        value: string | number | boolean;
    };
}): EntryPageQuery | null {
    const fail: (message: string) => never = message => invalid(message, options.path);
    const filters: Record<string, EntryScalar | {readonly in: readonly EntryScalar[]}> = Object.create(null);
    const set = (column: string, value: EntryScalar | {readonly in: readonly EntryScalar[]}) => {
        if (Object.hasOwn(filters, column) && JSON.stringify(filters[column]) !== JSON.stringify(value))
            return false;
        Object.defineProperty(filters, column, { value, writable: true, enumerable: true, configurable: true });
        return true;
    };
    if (options.publishing) {
        const status = params.get("status");
        if (status && status !== "all") {
            if (!["draft", "published", "archived"].includes(status))
                fail("Unknown publishing status.");
            set("status", status);
        }
    }
    for (const prefix of ["filter", "scope"]) {
        const name = params.get(prefix + "_field"), raw = params.get(prefix + "_value");
        if (!name && raw !== null || name && raw === null && !(prefix === "filter" && params.has("filter_values")))
            fail("Filter field and value must be paired.");
        if (name && raw !== null) {
            const f = options.field(name, raw);
            if (!set(f.column, f.value))
                return null;
        }
    }
    if (params.has("filter_values")) {
        const name = params.get("filter_field");
        if (!name || params.has("filter_value"))
            fail("filter_values needs filter_field without filter_value.");
        let raw: unknown;
        try {
            raw = JSON.parse(params.get("filter_values")!);
        }
        catch {
            return fail("filter_values must be JSON.");
        }
        if (!Array.isArray(raw) || raw.length > 50 || raw.some(v => v === null || !["string", "number", "boolean"].includes(typeof v)))
            fail("filter_values takes at most 50 scalar values.");
        if (!raw.length)
            return null;
        const mapped = raw.map(v => options.field(name, String(v))), column = mapped[0]!.column, values = mapped.map(f => f.value);
        if (Object.hasOwn(filters, column)) {
            if (!values.includes(filters[column] as string | number | boolean))
                return null;
        }
        else
            set(column, { in: values });
    }
    if (params.get("cursor_direction") === "backward")
        fail("Only forward cursors are supported.");
    const sort = params.get("sort") || "updatedAt", direction = params.get("direction") || "desc";
    if (!Object.hasOwn(options.orderFields, sort) || !["asc", "desc"].includes(direction))
        fail("Unknown indexed sort or direction.");
    const { limit: givenLimit, cursor } = readQuery(params, raw => raw as Record<string, unknown>, options.path, []), limit = givenLimit ?? 50;
    if (limit < 1 || limit > 500)
        fail("limit is 1 to 500.");
    const search = (params.get("q") ?? params.get("search"))?.trim();
    if (search?.includes("\0"))
        fail("Search must not contain NUL.");
    if (!options.sqlite)
        for (const value of Object.values(filters))
            nativeText(value);
    return { input: {}, order: options.orderFields[sort] + ":" + direction, limit, ...(cursor ? {cursor} : {}), match: {filters, ...(search ? {search} : {})} };
}
