/**
 * Better Auth `database` adapters on the same native handle as the data layer: a Cloudflare D1 binding or Bun.SQL.
 * No Kysely. Rules (where semantics, joins, field/model mapping, value transforms) come from Better Auth's own
 * `createAdapterFactory`; this file only turns its already-normalised calls into parameterised SQL.
 * `consumeOne` and `incrementOne` are single statements: D1 has no transactions, and they guard OTP consumption and
 * attempt counting.
 */
import { createAdapterFactory, type CleanedWhere, type CustomAdapter, type DBAdapterFactoryConfig, type JoinConfig } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "@better-auth/core";
import { APIError } from "@better-auth/core/error";
import { getAuthTables } from "@better-auth/core/db";
import type { OAuthOptions } from "@better-auth/oauth-provider";
import { resourceSeeds } from "./resource-seeds.js";
import { ContractError } from "../kernel/contracts.js";
import { adminOptionsOf } from "./caller.js";
import type { SQL } from "bun";
import type { Dialect } from "../kernel/dialect/common.js";
import * as postgres from "../kernel/dialect/postgres.js";
import * as sqlite from "../kernel/dialect/sqlite.js";
import * as bunSql from "../kernel/driver/postgres.js";
import type { Reader } from "../kernel/driver/d1.js";
import { condition as spell } from "../kernel/where.js";

type Row = Record<string, unknown>;
/** Runs one statement; `changes` is the affected-row count. */
type Exec = (text: string, values: unknown[], protectAdmin?: boolean) => ReturnType<typeof bunSql.run>;
const nativeReaders = new WeakMap<object, { exec: Exec; param(n: number): string; now(ms: number): Date | string }>();
/** Selected auth queries share this adapter's handle, dialect and Better Auth's physical model/field mapping. */
/** Better Auth's table and column names for these options (modelName/fieldName mapping); needs no database. */
export function authNames(options: BetterAuthOptions) {
  const schema = getAuthTables(options);
  return {
    table: (model: string) => postgres.ident(schema[model]!.modelName),
    column: (model: string, field: string) => postgres.ident(schema[model]?.fields[field]?.fieldName ?? field),
    has: (model: string, field: string) => field === "id" || !!schema[model]?.fields[field],
  };
}
export function nativeAuthRead(options: BetterAuthOptions) {
  const native = options.database && nativeReaders.get(options.database as object);
  if (!native) throw new ContractError("AUTH_CONFIGURATION_ERROR", "OAuth requires Mantle's native auth database adapter.", "auth:database");
  return { ...native, ...authNames(options) };
}
/** The slice of D1 the adapter calls (a real `D1Database` satisfies it). */
export type D1Like = Reader;
/** What one statement's builder is given: `bind` registers a parameter and returns its placeholder; `where` spells conditions with it. */
interface Statement { bind(value: unknown): string; where(modelKey: string, conditions: CleanedWhere[] | undefined, extra?: string): string }
type Spelling = Pick<Dialect, "param" | "ident" | "escapeLike" | "like" | "likeEscape">;

function customAdapter(d: Spelling, exec: Exec, seed: (identifier: string) => Promise<boolean>, insertOnly = false, options?: BetterAuthOptions) {
  const { ident } = d;
  return ({ getFieldName, schema, getDefaultModelName }: Parameters<Parameters<typeof createAdapterFactory>[0]["adapter"]>[0]): CustomAdapter => {
    const condition = (bind: Statement["bind"], modelKey: string, w: CleanedWhere): string => {
      const col = ident(getFieldName({ model: modelKey, field: w.field }));
      const { value, operator } = w;
      const fold = w.mode === "insensitive" && (typeof value === "string" || (Array.isArray(value) && value.every(v => typeof v === "string")));
      if (operator === "contains" || operator === "starts_with" || operator === "ends_with") {
        const text = d.escapeLike(String(value));
        return spell(d, col, "like", operator === "contains" ? `%${text}%` : operator === "starts_with" ? `${text}%` : `%${text}`, bind, fold);
      }
      return spell(d, col, operator === "not_in" ? "notIn" : operator, value, bind, fold);
    };
    /** Builds one statement (its own parameters) and runs it. `where` is `WHERE (and...) AND (or...)`, the Kysely adapter's grouping; empty without conditions. */
    const run = (build: (s: Statement) => string, protectAdmin = false) => {
      const values: unknown[] = [];
      const bind = (value: unknown) => (values.push(value === undefined ? null : value), d.param(values.length));
      const where: Statement["where"] = (modelKey, conditions, extra) => {
        const group = (connector: "AND" | "OR") => {
          const parts = (conditions ?? []).filter(w => (w.connector === "OR" ? "OR" : "AND") === connector).map(w => condition(bind, modelKey, w));
          return parts.length ? `(${parts.join(` ${connector} `)})` : null;
        };
        const parts = [group("AND"), group("OR"), extra ?? null].filter(Boolean);
        return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
      };
      return exec(build({ bind, where }), values, protectAdmin);
    };
    const idOf = (modelKey: string) => ident(getFieldName({ model: modelKey, field: "id" }));
    /** The WHERE plus `<id> IN (SELECT <id> FROM t WHERE ... LIMIT 1)`: the statement touches at most one row. */
    const oneRow = (s: Statement, table: string, modelKey: string, where: CleanedWhere[]) =>
      s.where(modelKey, where, `${idOf(modelKey)} IN (SELECT ${idOf(modelKey)} FROM ${ident(table)}${s.where(modelKey, where)} LIMIT 1)`);
    /** The one row a `RETURNING *` statement changed, else null. */
    const one = async (build: (s: Statement) => string) => ((await run(s => `${build(s)} RETURNING *`)).rows[0] ?? null) as never;
    /** The columns a write gives (an `undefined` is no value). */
    const cols = (values: Row) => Object.entries(values).filter(([, v]) => v !== undefined);
    const assign = (s: Statement, values: Row, increment: Record<string, number> = {}) =>
      [...cols(values).map(([c, v]) => `${ident(c)} = ${s.bind(v)}`), ...Object.entries(increment).map(([c, n]) => `${ident(c)} = ${ident(c)} + ${s.bind(n)}`)].join(", ");
    const { adminRoles: roles, adminUserIds } = options ? adminOptionsOf({ options }) : { adminRoles: [] as string[], adminUserIds: [] as readonly string[] };
    const holdsAdmin = (role: unknown) => typeof role === "string" && role.split(",").some(role => roles.includes(role));
    const field = (name: string) => getFieldName({ model: "user", field: name });
    const protects = (modelKey: string, values?: Row) => modelKey === "user" && roles.length > 0 &&
      (!values || values[field("banned")] === true || values[field("banned")] === 1 || Object.hasOwn(values, field("role")) && !holdsAdmin(values[field("role")]));
    const membership = (s: Statement, alias: string) => '(' + roles.map(role => `${d === sqlite ? "instr" : "strpos"}(',' || COALESCE(${alias}.${ident(field("role"))}, '') || ',', ${s.bind(',' + role + ',')}) > 0`).join(' OR ') + ')';
    const lastAdminGuard = (s: Statement, model: string) => {
      const table = ident(model), other = '"_mantle_other_admin"', no = d === sqlite ? '0' : 'FALSE';
      return `(NOT ${membership(s, table)} OR EXISTS (SELECT 1 FROM ${table} ${other} WHERE (${membership(s, other)}${adminUserIds.map(id => ` OR ${other}.${idOf("user")} = ${s.bind(id)}`).join("")}) AND ${other}.${idOf("user")} <> ${table}.${idOf("user")} AND COALESCE(${other}.${ident(field("banned"))}, ${no}) = ${no}))`;
    };
    const mutation = async (model: string, modelKey: string, where: CleanedWhere[], values?: Row) => {
      const protect = protects(modelKey, values);
      if (protect && (where.length !== 1 || where[0]!.field !== field("id") || where[0]!.operator && where[0]!.operator !== "eq"))
        throw new APIError("FORBIDDEN", { code: "AUTH_DENIED", message: "Destructive admin identity writes require one user id." });
      const result = await run(s => `${values ? `UPDATE ${ident(model)} SET ${assign(s, values)}` : `DELETE FROM ${ident(model)}`}${s.where(modelKey, where, protect ? lastAdminGuard(s, model) : undefined)} RETURNING *`, protect);
      if (protect && !result.changes && (await run(s => `SELECT ${idOf(modelKey)} FROM ${ident(model)}${s.where(modelKey, where, `NOT ${lastAdminGuard(s, model)}`)} LIMIT 1`)).rows.length)
        throw new APIError("CONFLICT", { code: "CONFLICT", message: "This is the last admin; promote another admin before removing or banning this one." });
      return result;
    };
    const deleteMany = async ({ model, modelKey = model, where }: { model: string; modelKey?: string; where: CleanedWhere[] }) =>
      (await mutation(model, modelKey, where)).changes;

    /** Joined rows come back as flat `__j<i>__<column>` aliases; fold them into `row[joinModel]` (object or array). */
    const joinColumns = (join: JoinConfig) =>
      Object.entries(join).map(([model, config]) => {
        const fields = schema[config.modelKey ?? getDefaultModelName(model)]?.fields ?? {};
        return [...new Set(["id", ...Object.entries(fields).map(([field, attr]) => attr.fieldName || field)])];
      });
    const foldJoins = (rows: Row[], join: JoinConfig, idColumn: string) => {
      const entries = Object.entries(join);
      const grouped = new Map<unknown, Row>();
      rows.forEach((raw, index) => {
        const main: Row = {};
        const joined: Row[] = entries.map(() => ({}));
        for (const [key, value] of Object.entries(raw)) {
          const m = /^__j(\d+)__(.*)$/s.exec(key);
          if (m) joined[Number(m[1])]![m[2]!] = value;
          else main[key] = value;
        }
        const key = main[idColumn] ?? index;
        let entry = grouped.get(key);
        if (!entry) {
          entry = { ...main };
          entries.forEach(([model, config]) => (entry![model] = config.relation === "one-to-one" ? null : []));
          grouped.set(key, entry);
        }
        entries.forEach(([model, config], i) => {
          const obj = joined[i]!;
          if (!Object.values(obj).some(v => v !== null && v !== undefined)) return;
          if (config.relation === "one-to-one") entry![model] = obj;
          else {
            const list = entry![model] as Row[];
            if (!list.some(item => item.id !== undefined && item.id === obj.id)) list.push(obj);
          }
        });
      });
      return [...grouped.values()];
    };

    const select = async (model: string, modelKey: string, o: { where?: CleanedWhere[]; select?: string[]; limit?: number; offset?: number; sortBy?: { field: string; direction: string }; join?: JoinConfig }) => {
      const column = (field: string) => getFieldName({ model: modelKey, field });
      const sortColumn = o.sortBy?.field ? ident(column(o.sortBy.field)) : null;
      const order = (prefix = "") => (sortColumn ? ` ORDER BY ${prefix}${sortColumn} ${o.sortBy!.direction === "desc" ? "DESC" : "ASC"}` : "");
      // With a join the primary subquery also needs the id (rows fold by it), every join key and the sort column; they are dropped again below.
      const wanted = o.select?.length ? o.select.map(column) : null;
      const needed = o.join ? [column("id"), ...Object.values(o.join).map(c => c.on.from), ...(o.sortBy ? [column(o.sortBy.field)] : [])] : [];
      const { rows } = await run(s => {
        const list = wanted ? [...new Set([...wanted, ...needed])].map(ident).join(", ") : "*";
        const paging = `${o.limit !== undefined ? ` LIMIT ${Math.trunc(o.limit)}` : ""}${o.offset ? ` OFFSET ${Math.trunc(o.offset)}` : ""}`;
        const primary = `SELECT ${list} FROM ${ident(model)}${s.where(modelKey, o.where)}${order()}${paging}`;
        if (!o.join) return primary;
        const entries = Object.entries(o.join);
        const names = joinColumns(o.join);
        // The CTE is MATERIALIZED so an unordered LIMIT picks the same parents in both of its uses. One-to-many: number each parent's joined rows in SQL and keep the first `limit`, so only that many rows ever leave the database.
        const joinSql = entries.map(([joined, c], i) => {
          const source = c.relation === "one-to-one" ? ident(joined)
            : `(SELECT *, ROW_NUMBER() OVER (PARTITION BY ${ident(c.on.to)} ORDER BY ${idOf(c.modelKey ?? getDefaultModelName(joined))}) AS "__rn" FROM ${ident(joined)} WHERE ${ident(c.on.to)} IN (SELECT ${ident(c.on.from)} FROM "primary"))`;
          return ` LEFT JOIN ${source} AS "j${i}" ON "j${i}".${ident(c.on.to)} = "primary".${ident(c.on.from)}${c.relation === "one-to-one" ? "" : ` AND "j${i}"."__rn" <= ${Math.trunc(c.limit ?? 100)}`}`;
        }).join("");
        const joinSelect = entries.flatMap((_, i) => names[i]!.map(c => `"j${i}".${ident(c)} AS ${ident(`__j${i}__${c}`)}`)).join(", ");
        return `WITH "primary" AS MATERIALIZED (${primary}) SELECT "primary".*, ${joinSelect} FROM "primary"${joinSql}${order('"primary".')}`;
      });
      if (!o.join) return rows;
      const folded = foldJoins(rows, o.join, column("id"));
      if (wanted) for (const row of folded) for (const extra of needed) if (!wanted.includes(extra)) delete row[extra];
      return folded;
    };

    return {
      async create({ data, model }) {
        const given = cols(data);
        const { rows } = await run(s => `INSERT INTO ${ident(model)}${given.length ? ` (${given.map(([c]) => ident(c)).join(", ")}) VALUES (${given.map(([, v]) => s.bind(v)).join(", ")})` : " DEFAULT VALUES"} ${insertOnly ? "ON CONFLICT DO NOTHING " : ""}RETURNING *`);
        return rows[0] as never;
      },
      async findOne({ model, modelKey = model, where, select: fields, join }) {
        let row = (await select(model, modelKey, { where, select: fields, limit: 1, join }))[0] ?? null;
        if (!row && modelKey === "oauthResource" && where?.length === 1 && where[0]!.field === getFieldName({ model: modelKey, field: "identifier" }) && (!where[0]!.operator || where[0]!.operator === "eq") && await seed(where[0]!.value as string)) {
          row = (await select(model, modelKey, { where, select: fields, limit: 1, join }))[0] ?? null;
        }
        return row as never;
      },
      async findMany({ model, modelKey = model, where, limit, select: fields, sortBy, offset, join }) {
        return (await select(model, modelKey, { where, select: fields, limit, offset, sortBy, join })) as never;
      },
      async update({ model, modelKey = model, where, update }) {
        if (!where.length) return null;
        return ((await mutation(model, modelKey, where, update as Row)).rows[0] ?? null) as never;
      },
      async updateMany({ model, modelKey = model, where, update }) {
        return (await mutation(model, modelKey, where, update)).changes;
      },
      async delete(options) { await deleteMany(options); },
      deleteMany,
      async consumeOne({ model, modelKey = model, where }) {
        return one(s => `DELETE FROM ${ident(model)}${oneRow(s, model, modelKey, where)}`);
      },
      async incrementOne({ model, modelKey = model, where, increment, set }) {
        return one(s => `UPDATE ${ident(model)} SET ${assign(s, set ?? {}, increment)}${oneRow(s, model, modelKey, where)}`);
      },
      async count({ model, modelKey = model, where }) {
        const { rows } = await run(s => `SELECT COUNT(*) AS "count" FROM ${ident(model)}${s.where(modelKey, where)}`);
        return Number(rows[0]!.count);
      },
    };
  };
}

function build(d: Spelling, native: boolean, adapterId: string, adapterName: string, exec: Exec, transaction: DBAdapterFactoryConfig["transaction"], options: BetterAuthOptions) {
  const resources = new Map((options.plugins ?? []).flatMap(plugin => plugin.id === "oauth-provider" ? resourceSeeds(plugin.options as OAuthOptions).map(input => {
    const resource = typeof input === "string" ? { identifier: input } : input;
    return [resource.identifier, { resource, options: plugin.options as OAuthOptions }] as const;
  }) : []).reverse()); // first configured entry wins, as upstream insertOnly does
  // ponytail: one seed per identifier per isolate (upstream seeds once per init); disable a configured resource rather than deleting it.
  const seeded = new Set<string>();
  let writer: ReturnType<ReturnType<typeof createAdapterFactory>> | undefined;
  const pending = new Map<string, Promise<boolean>>();
  const seed = (identifier: string): Promise<boolean> => {
    const configured = resources.get(identifier);
    if (!configured || seeded.has(identifier)) return Promise.resolve(false);
    let work = pending.get(identifier);
    if (!work) {
      work = (async () => {
        const { resource, options: oauth } = configured;
        // Match upstream identifier validation and seed row defaults.
        let valid: boolean;
        try { valid = oauth.identifierValidator ? !!(await oauth.identifierValidator(identifier)) : !new URL(identifier).hash; } catch { valid = false; }
        if (!valid) throw new APIError("INTERNAL_SERVER_ERROR", { code: "AUTH_CONFIGURATION_ERROR", message: "Configured OAuth resource identifier failed validation." });
        const now = new Date();
        const data = {
          identifier, name: resource.name ?? identifier,
          ...Object.fromEntries(["accessTokenTtl", "refreshTokenTtl", "signingKeyId", "allowedScopes", "customClaims", "metadata"].map(field => [field, resource[field as keyof typeof resource] ?? null])),
          signingAlgorithm: resource.signingAlgorithm && ["EdDSA", "ES256", "ES512", "PS256", "RS256"].includes(resource.signingAlgorithm) ? resource.signingAlgorithm : null,
          dpopBoundAccessTokensRequired: resource.dpopBoundAccessTokensRequired ?? false, disabled: resource.disabled ?? false,
          policyVersion: 1, createdAt: now, updatedAt: now,
        };
        // The factory owns ID generation, field mapping and native date/JSON/boolean encoding, including for seeds.
        writer ??= createAdapterFactory({ config, adapter: customAdapter(d, exec, async () => false, true) })(options);
        await writer.create({ model: "oauthResource", data });
        seeded.add(identifier);
        return true;
      })().finally(() => pending.delete(identifier));
      pending.set(identifier, work);
    }
    return work;
  };
  const config: DBAdapterFactoryConfig = {
    adapterId, adapterName, supportsBooleans: native, supportsDates: native, supportsJSON: native, supportsUUIDs: native, transaction,
    // Bun.SQL returns int8/numeric as strings; a `number` field must reach Better Auth as a number (the rate limiter adds to `lastRequest`). Ids stay strings.
    customTransformOutput: ({ data, fieldAttributes, field }) => (fieldAttributes.type === "number" && typeof data === "string" && field !== "id" && !fieldAttributes.references ? Number(data) : data),
  };
  const factory = createAdapterFactory({ config, adapter: customAdapter(d, exec, seed, false, options) });
  // Both native adapters implement joins; Better Auth otherwise emulates each joined read with another statement.
  return (options: BetterAuthOptions) => factory({ ...options, advanced: { ...options.advanced, database: { ...options.advanced?.database, joins: options.advanced?.database?.joins ?? true } } });
}

/** Cloudflare D1 (SQLite). D1 has no interactive transactions, so `transaction` is off and the atomic operations are single statements. */
export function d1Adapter(db: D1Like) {
  const exec: Exec = async (text, values) => {
    const { results, meta } = await db.prepare(text).bind(...values).all();
    return { rows: results, changes: meta.changes };
  };
  const factory = (options: BetterAuthOptions) => build(sqlite, false, "d1", "Mantle D1 Adapter", exec, false, options)(options);
  nativeReaders.set(factory, { exec, param: sqlite.param, now: ms => new Date(ms).toISOString() });
  return factory;
}

/** Bun.SQL against PostgreSQL. Transactions use `sql.begin`, which pins every statement to one connection. */
export function bunSqlAdapter(sql: SQL) {
  const executor = (handle: Pick<SQL, "unsafe">): Exec => async (text, values, protectAdmin) => {
    const run = async (tx: Pick<SQL, "unsafe">) => {
      if (protectAdmin) await tx.unsafe("SELECT pg_advisory_xact_lock(1296125516,1)", []);
      return bunSql.run(tx as never, text, values);
    };
    return protectAdmin && handle === sql ? sql.begin(tx => run(tx)) : run(handle);
  };
  const make = (handle: Pick<SQL, "unsafe">, transaction: DBAdapterFactoryConfig["transaction"]) => (options: BetterAuthOptions) => build(postgres, true, "bun-sql", "Mantle Bun.SQL Adapter", executor(handle), transaction, options)(options);
  const factory = (options: BetterAuthOptions) => make(sql, cb => sql.begin(tx => cb(make(tx, false)(options))))(options);
  nativeReaders.set(factory, { exec: executor(sql), param: postgres.param, now: postgres.now });
  return factory;
}
