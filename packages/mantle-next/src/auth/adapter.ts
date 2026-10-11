/**
 * Better Auth `database` adapters on the same native handle as the data layer: a Cloudflare D1 binding or Bun.SQL.
 * No Kysely. Rules (where semantics, joins, field/model mapping, value transforms) come from Better Auth's own
 * `createAdapterFactory`; this file only turns its already-normalised calls into parameterised SQL.
 * `consumeOne` and `incrementOne` are single statements: D1 has no transactions, and they guard OTP consumption and
 * attempt counting.
 */
import { createAdapterFactory, type CleanedWhere, type CustomAdapter, type DBAdapterFactoryConfig, type JoinConfig } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "@better-auth/core";
import type { SQL } from "bun";
import type { Dialect } from "../kernel/dialect/common.js";
import * as postgres from "../kernel/dialect/postgres.js";
import * as sqlite from "../kernel/dialect/sqlite.js";
import * as bunSql from "../kernel/driver/postgres.js";
import * as d1 from "../kernel/driver/d1.js";
import { condition as spell } from "../kernel/where.js";

type Row = Record<string, unknown>;
/** Runs one statement; `changes` is the affected-row count. */
type Exec = (text: string, values: unknown[]) => Promise<{ rows: Row[]; changes: number }>;
/** The slice of D1 the adapter calls (a real `D1Database` satisfies it). */
export type D1Like = d1.Reader;

function customAdapter(d: Dialect, exec: Exec) {
  const { ident } = d;
  return ({ getFieldName, schema, getDefaultModelName }: Parameters<Parameters<typeof createAdapterFactory>[0]["adapter"]>[0]): CustomAdapter => {
    /** One statement under construction: text plus its parameters. */
    const stmt = () => {
      const values: unknown[] = [];
      const bind = (value: unknown) => {
        values.push(value === undefined ? null : value);
        return d.param(values.length);
      };
      const condition = (modelKey: string, w: CleanedWhere): string => {
        const col = ident(getFieldName({ model: modelKey, field: w.field }));
        const { value, operator } = w;
        const fold = w.mode === "insensitive" && (typeof value === "string" || (Array.isArray(value) && value.every(v => typeof v === "string")));
        if (operator === "contains" || operator === "starts_with" || operator === "ends_with") {
          const text = d.escapeLike(String(value));
          return spell(d, col, "like", operator === "contains" ? `%${text}%` : operator === "starts_with" ? `${text}%` : `%${text}`, bind, fold);
        }
        return spell(d, col, operator === "not_in" ? "notIn" : operator, value, bind, fold);
      };
      /** `WHERE (and...) AND (or...)`, the Kysely adapter's grouping; empty without conditions. */
      const where = (modelKey: string, conditions: CleanedWhere[] | undefined, extra?: string) => {
        const group = (connector: "AND" | "OR") => {
          const parts = (conditions ?? []).filter(w => (w.connector === "OR" ? "OR" : "AND") === connector).map(w => condition(modelKey, w));
          return parts.length ? `(${parts.join(` ${connector} `)})` : null;
        };
        const parts = [group("AND"), group("OR"), extra ?? null].filter(Boolean);
        return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
      };
      return { values, bind, where };
    };
    const run = async (build: (s: ReturnType<typeof stmt>) => string) => {
      const s = stmt();
      const text = build(s);
      return exec(text, s.values);
    };
    const idOf = (modelKey: string) => ident(getFieldName({ model: modelKey, field: "id" }));
    /** `<id> IN (SELECT <id> FROM t WHERE ... LIMIT 1)`: the statement touches at most one row. */
    const oneRow = (s: ReturnType<typeof stmt>, table: string, modelKey: string, where: CleanedWhere[]) =>
      `${idOf(modelKey)} IN (SELECT ${idOf(modelKey)} FROM ${ident(table)}${s.where(modelKey, where)} LIMIT 1)`;
    const assign = (s: ReturnType<typeof stmt>, values: Row, increment: Record<string, number> = {}) =>
      [...Object.entries(values).filter(([, v]) => v !== undefined).map(([c, v]) => `${ident(c)} = ${s.bind(v)}`), ...Object.entries(increment).map(([c, n]) => `${ident(c)} = ${ident(c)} + ${s.bind(n)}`)].join(", ");

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
        const keys = Object.keys(data).filter(k => data[k] !== undefined);
        const { rows } = await run(s => `INSERT INTO ${ident(model)}${keys.length ? ` (${keys.map(ident).join(", ")}) VALUES (${keys.map(k => s.bind(data[k])).join(", ")})` : " DEFAULT VALUES"} RETURNING *`);
        return rows[0] as never;
      },
      async findOne({ model, modelKey = model, where, select: fields, join }) {
        return ((await select(model, modelKey, { where, select: fields, limit: 1, join }))[0] ?? null) as never;
      },
      async findMany({ model, modelKey = model, where, limit, select: fields, sortBy, offset, join }) {
        return (await select(model, modelKey, { where, select: fields, limit, offset, sortBy, join })) as never;
      },
      async update({ model, modelKey = model, where, update }) {
        if (!where.length) return null;
        const { rows } = await run(s => `UPDATE ${ident(model)} SET ${assign(s, update as Row)}${s.where(modelKey, where)} RETURNING *`);
        return (rows[0] ?? null) as never;
      },
      async updateMany({ model, modelKey = model, where, update }) {
        return (await run(s => `UPDATE ${ident(model)} SET ${assign(s, update)}${s.where(modelKey, where)}`)).changes;
      },
      async delete({ model, modelKey = model, where }) {
        await run(s => `DELETE FROM ${ident(model)}${s.where(modelKey, where)}`);
      },
      async deleteMany({ model, modelKey = model, where }) {
        return (await run(s => `DELETE FROM ${ident(model)}${s.where(modelKey, where)}`)).changes;
      },
      async consumeOne({ model, modelKey = model, where }) {
        const { rows } = await run(s => `DELETE FROM ${ident(model)}${s.where(modelKey, where, oneRow(s, model, modelKey, where))} RETURNING *`);
        return (rows[0] ?? null) as never;
      },
      async incrementOne({ model, modelKey = model, where, increment, set }) {
        const { rows } = await run(s => `UPDATE ${ident(model)} SET ${assign(s, set ?? {}, increment)}${s.where(modelKey, where, oneRow(s, model, modelKey, where))} RETURNING *`);
        return (rows[0] ?? null) as never;
      },
      async count({ model, modelKey = model, where }) {
        const { rows } = await run(s => `SELECT COUNT(*) AS "count" FROM ${ident(model)}${s.where(modelKey, where)}`);
        return Number(rows[0]!.count);
      },
    };
  };
}

function build(d: Dialect, adapterId: string, adapterName: string, exec: Exec, transaction: DBAdapterFactoryConfig["transaction"]) {
  return createAdapterFactory({
    config: {
      adapterId, adapterName, supportsBooleans: d.nativeTypes, supportsDates: d.nativeTypes, supportsJSON: d.nativeTypes, supportsArrays: false, supportsUUIDs: d.nativeTypes, transaction,
      // Bun.SQL returns int8/numeric as strings; a `number` field must reach Better Auth as a number (the rate limiter adds to `lastRequest`). Ids stay strings.
      customTransformOutput: ({ data, fieldAttributes, field }) => (fieldAttributes.type === "number" && typeof data === "string" && field !== "id" && !fieldAttributes.references ? Number(data) : data),
    },
    adapter: customAdapter(d, exec),
  });
}

/** Cloudflare D1 (SQLite). D1 has no interactive transactions, so `transaction` is off and the atomic operations are single statements. */
export function d1Adapter(db: D1Like) {
  return build(sqlite, "d1", "Mantle D1 Adapter", (text, values) => d1.run(db, text, values), false);
}

/** Bun.SQL against PostgreSQL. Transactions use `sql.begin`, which pins every statement to one connection. */
export function bunSqlAdapter(sql: SQL) {
  const executor = (handle: Pick<SQL, "unsafe">): Exec => (text, values) => bunSql.run(handle as never, text, values);
  // Each `betterAuth` instance gets its own factory; its transactions rebuild the adapter on the pinned connection with the same options.
  return (options: BetterAuthOptions) =>
    build(postgres, "bun-sql", "Mantle Bun.SQL Adapter", executor(sql), cb =>
      sql.begin(tx => cb(build(postgres, "bun-sql", "Mantle Bun.SQL Adapter", executor(tx), false)(options))))(options);
}
