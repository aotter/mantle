import { modeOf } from "@aotter/mantle/user-fields";
/** Selected generated native adapters: constants and compiled predicates, never a manifest interpreter. */
import { ContractError, isAdmin, deny, type Caller, type Row } from "@aotter/mantle/contracts";
import { binds, bound, type Recipe, type Step, type Bound, type Values } from "@aotter/mantle/binds";
import { query as readQuery } from "@aotter/mantle/validation";
import { invalid } from "@aotter/mantle/surface";
import { checkPageLimit, page, decodeNullableCursor, encodeCursor, validCursor, type CursorKind, type Pages } from "@aotter/mantle/paging";
import type {EntryPageQuery, EntryScalar} from "./entries.js";
const selectMode = <T>(spec: {readonly caller:T;readonly trusted:T}, caller:Caller, d: Values):T => {
    const m = modeOf(caller) === 'trusted' ? spec.trusted : spec.caller;
    return d.scopedAll ? d.scopedAll(m, caller) : m;
};
export interface NativeAdapter<Database> {
    readonly read: (db: Database, sql: string, values: unknown[]) => PromiseLike<Row[]> | Row[];
    readonly values: Values;
    readonly param: (n: number) => string;
    readonly escapeLike: (s: string) => string;
    readonly sqlite: boolean;
}
export async function nativeStatistics<Database>(specs: Readonly<Record<string, NativeCollection>>, adapter: NativeAdapter<Database>, db: Database, caller: Caller, collection: string, args: {from: number; to: number; bucketMs: number}) {
    deny(caller, isAdmin(caller), "admin/statistics");
    if (!Object.hasOwn(specs, collection)) invalid("Unknown collection.", "admin/statistics");
    const spec = specs[collection]!, {from, to, bucketMs} = args;
    if (!spec.statistics || ![from, to, bucketMs].every(Number.isSafeInteger) || from < 0 || to <= from || bucketMs <= 0 || to - from > 20 * 86400000 || Math.ceil((to - from) / bucketMs) > 480 || Math.max(to, bucketMs) > Number.MAX_SAFE_INTEGER / 1000) invalid("Statistics require <=20 days and <=480 buckets.", "admin/statistics");
    const m = selectMode(spec, caller, adapter.values), values = binds(adapter.values, m.binds, caller);
    const policy = m.policy ? " WHERE (" + m.policy + ")" : "";
    const totalQuery = `SELECT -1 AS bucket, NULL AS subtype, count(*) AS count ${m.from}${policy}`;
    const parameter = (value: unknown) => {values.push(value); return adapter.param(values.length);};
    // Bindings generated without `column` compare the epoch-microsecond `time` expression, so they bind numbers.
    const micros = adapter.sqlite || !spec.statistics.column;
    const lower = parameter(micros ? from * 1000 : new Date(from).toISOString());
    const upper = parameter(micros ? to * 1000 : new Date(to).toISOString());
    const width = parameter(bucketMs * 1000);
    const time = spec.statistics.time, column = spec.statistics.column ?? time;
    const origin = micros ? lower : `extract(epoch FROM CAST(${lower} AS timestamptz)) * 1000000`;
    const division = `((${time} - ${origin}) / ${width})`;
    const bucket = adapter.sqlite ? `CAST(${division} AS INTEGER)` : `CAST(floor(${division}) AS bigint)`;
    // Independent aggregates avoid CTE materialization while retaining one native round trip.
    const rows = await adapter.read(db, `${totalQuery} UNION ALL SELECT ${bucket} AS bucket, ${spec.statistics.subtype} AS subtype, count(*) AS count ${m.from}${policy}${policy ? " AND" : " WHERE"} ${column} >= ${lower} AND ${column} < ${upper} GROUP BY 1, 2 ORDER BY bucket, subtype`, values);
    const total = Number(rows.find(row => Number(row.bucket) === -1)?.count ?? 0);
    const buckets = rows.filter(row => Number(row.bucket) !== -1).map(row => ({bucket: Number(row.bucket), subtype: row.subtype == null ? null : String(row.subtype), count: Number(row.count)}));
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
    const m = selectMode(spec, caller, adapter.values);
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
/** Per `x-mantle-ref` field to a scoped Schema, Core's check of a written value: each hole token takes a written field's value or a bind. */
export type RefChecks = Readonly<Record<string, {readonly sql: string; readonly holes: readonly (readonly [token: string, value: string | Recipe])[]}>>;
/** Constant procedure fragments and recipes are printed by Core; the app supplies only checked values. */
export interface NativeEntryMode {
    readonly projection: string;
    readonly from: string;
    readonly policy: string;
    readonly binds: readonly Recipe[];
    readonly fields: Readonly<Record<string, {readonly column: string; readonly insert: string; readonly update?: string}>>;
    readonly create: {readonly prefix: string; readonly between: string; readonly suffix: string; readonly binds: readonly Recipe[]; readonly columns: readonly string[]; readonly values: readonly string[]; readonly returning: string; readonly refs?: RefChecks};
    readonly patch: {readonly prefix: string; readonly binds: readonly Recipe[]; readonly sets: readonly string[]; readonly where: string; readonly returning: string; readonly refs?: RefChecks};
    readonly remove: Step;
}
export interface NativeEntryProcedures {
    readonly userScopes?: readonly { readonly column: string; readonly field: string; readonly type: "string" | "number" }[];
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
    readonly statistics?: {readonly column?: string; readonly time: string; readonly subtype: string; readonly rowsAlias: {readonly name: string; readonly sql: string}};
}
export async function nativeEntryGet<Database>(spec: NativeCollection, adapter: NativeAdapter<Database>, db: Database, caller: Caller, id: string): Promise<Row | null> {
    if (typeof id !== "string" || !id) invalid("An entry id is required.", spec.path);
    if (!adapter.sqlite) nativeText(id);
    const m = selectMode(spec, caller, adapter.values), values = binds(adapter.values, m.binds, caller);
    values.push(id);
    const where = [m.policy, `${spec.id} = ${adapter.param(values.length)}`].filter(Boolean).map(term => "(" + term + ")").join(" AND ");
    return (await adapter.read(db, `SELECT ${m.projection} ${m.from} WHERE ${where} LIMIT 1`, values))[0] ?? null;
}
/** Prepare and execution admit only writable fields; inserts fill the caller's scope values. */
export function nativeEntryData(spec: NativeEntryProcedures, values: Values, caller: Caller, verb: "create" | "patch", data: Row): Row {
    const m = modeOf(caller) === 'trusted' ? spec.trusted : spec.caller;
    if (verb === "create" && spec.scoped && caller.kind === "anonymous") throw new ContractError("UNAUTHENTICATED", "A scoped insert requires an authenticated caller.", spec.path);
    if (verb === "create" && spec.userScopes?.length) data = values.scopeInsert!(spec.userScopes, caller, data) as Row;
    for (const [field, value] of Object.entries(data)) {
        if (!Object.hasOwn(m.fields, field) || value === undefined) invalid("Unknown writable field or missing value.", spec.path);
        if (verb === "patch" && !m.fields[field]!.update) throw new ContractError("AUTH_DENIED", "The scoped column is never writable through SET.", spec.path);
    }
    return data;
}
export async function nativeEntryProcedure<Database>(spec: NativeEntryProcedures, adapter: NativeProcedureAdapter<Database>, db: Database, caller: Caller, verb: "create", data: Row, id?: string, version?: number | string): Promise<Row>;
export async function nativeEntryProcedure<Database>(spec: NativeEntryProcedures, adapter: NativeProcedureAdapter<Database>, db: Database, caller: Caller, verb: "patch", data: Row, id: string, version: number | string): Promise<Row>;
export async function nativeEntryProcedure<Database>(spec: NativeEntryProcedures, adapter: NativeProcedureAdapter<Database>, db: Database, caller: Caller, verb: "remove", data: Row, id: string, version: number | string): Promise<void>;
export async function nativeEntryProcedure<Database>(spec: NativeEntryProcedures, adapter: NativeProcedureAdapter<Database>, db: Database, caller: Caller, verb: "create" | "patch" | "remove", data: Row, id?: string, version?: number | string): Promise<Row | void> {
    const m = selectMode(spec, caller, adapter.values), context = {id, version};
    if (verb !== "create" && (typeof id !== "string" || !id || !exactVersion(version))) invalid("An id and exact version are required.", spec.path);
    if (verb !== "remove") data = nativeEntryData(spec, adapter.values, caller, verb, data);
    if (!adapter.sqlite) {nativeText(context); nativeText(data);}
    if (verb === "remove") {
        await adapter.procedure(db, bound(adapter.values, [m.remove], caller, context), spec.path);
        return;
    }
    const present = Object.entries(data).map(([field, value]) => {
        return {field, fragment: m.fields[field]!, value};
    });
    const c = verb === "create" ? m.create : m.patch;
    const values = binds(adapter.values, c.binds, caller, context), params = new Map<string, string>();
    const fragments = present.map(({field, fragment, value}) => {
        values.push(value);
        params.set(field, adapter.param(values.length));
        return (verb === "create" ? fragment.insert : fragment.update!).replaceAll(spec.marker, adapter.param(values.length));
    });
    // A non-null reference to a scoped Schema names a row the caller sees, in the child's partition; else no row is written (CONFLICT).
    const checks = present.filter(({field, value}) => value !== null && c.refs?.[field]).map(({field}) => c.refs![field]!.holes.reduce((sql, [token, hole]) => {
        const text = typeof hole === "string" ? params.has(hole) ? m.fields[hole]!.insert.replaceAll(spec.marker, params.get(hole)!) : "NULL"
            : (values.push(...binds(adapter.values, [hole], caller, context)), adapter.param(values.length));
        return sql.replaceAll(token, () => text);
    }, c.refs![field]!.sql));
    const sql = verb === "create"
        ? m.create.prefix + [...m.create.columns, ...present.map(({fragment}) => fragment.column)].join(", ") + (checks.length ? ") SELECT " : m.create.between) + [...m.create.values, ...fragments].join(", ") + (checks.length ? " WHERE " + checks.join(" AND ") : m.create.suffix) + m.create.returning
        : m.patch.prefix + [...m.patch.sets, ...fragments].join(", ") + m.patch.where + checks.map(check => " AND " + check).join("") + m.patch.returning;
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
    checkPageLimit(limit, spec.path);
    const m = selectMode(spec, caller, adapter.values), filters = query.match?.filters ?? {}, search = query.match?.search;
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
    checkPageLimit(limit, options.path);
    const search = (params.get("q") ?? params.get("search"))?.trim();
    if (search?.includes("\0"))
        fail("Search must not contain NUL.");
    if (!options.sqlite)
        for (const value of Object.values(filters))
            nativeText(value);
    return { input: {}, order: options.orderFields[sort] + ":" + direction, limit, ...(cursor ? {cursor} : {}), match: {filters, ...(search ? {search} : {})} };
}
