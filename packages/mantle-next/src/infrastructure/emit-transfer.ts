/** Build-time portable table/SQL descriptor; no RuntimePlan reaches the exported Worker entry. */
import type { RuntimePlan, SiteDefaults } from "@aotter/mantle/spec";
import { notNullColumns } from "@aotter/mantle/spec";
import type { BetterAuthOptions } from "better-auth/types";
import { getAuthTables } from "@better-auth/core/db";
import { orderedTables } from "../auth/schema.js";
import type { DumpColumn, DumpPlan, DumpTable } from "../kernel/transfer.js";
import { ident } from "../kernel/dialect/common.js";
import * as pg from "../kernel/dialect/postgres.js";
import * as sqlite from "../kernel/dialect/sqlite.js";
import { driverFor, databaseImport, isSqlite, q } from "../domain/entry.js";
import type { Target } from "../domain/model.js";

const kind = (type: string): DumpColumn[1] => ({ text: "text", integer: "int", int4: "int", int8: "int", real: "real", float8: "real", bool: "bool", json: "json", timestamptz: "timestamp", date: "date" })[type] as DumpColumn[1];
export function emitTransfer(plan: RuntimePlan, target: Target, version: string, site?: SiteDefaults, auth?: BetterAuthOptions): Record<string, string> {
  const sq = isSqlite(target), dialect = sq ? sqlite : pg, tables: DumpTable[] = [], after: string[] = [], omitted: string[] = [];
  const add = (name: string, key: string, columns: DumpColumn[]) => {
    columns.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (columns.some(c => !c[1])) throw new Error(`Portable dump does not support a field in ${name}.`);
    const cast = (p: string, c: DumpColumn) => !sq && ["int","uuid"].includes(c[1]) ? `CAST(CAST(${p} AS text) AS ${c[1] === "int" ? "bigint" : "uuid"})` : dialect.cast(p, c[1] === "authdate" || c[1] === "timestamp" ? "timestamptz" : c[1]);
    const select = columns.map(c => {
      const column = ident(c[0]);
      const value = c[1] === "session" ? "NULL" : c[1] === "int" || c[1] === "json" ? `CAST(${column} AS TEXT)` : c[1] === "timestamp" || c[1] === "authdate" && !sq ? dialect.wireTimestamp(column).join("") : c[1] === "date" ? dialect.wireDate(column).join("") : column;
      return `${value} AS ${column}`;
    }).join(",");
    const base = `SELECT ${select} FROM ${ident(name)}`, keyColumn = columns.find(c => c[0] === key)!, keySql = ident(key) + (sq ? " COLLATE BINARY" : keyColumn[1] === "text" ? ' COLLATE "C"' : "");
    tables.push({ name, key, columns, first: `${base} ORDER BY ${keySql} LIMIT ${dialect.param(1)}`, next: `${base} WHERE ${keySql} > ${cast(dialect.param(1), keyColumn)} ORDER BY ${keySql} LIMIT ${dialect.param(2)}`, insert: [`INSERT INTO ${ident(name)}(${columns.map(c => ident(c[0])).join(",")}) VALUES`, columns.map(c => cast("?", c))] });
  };
  for (const [name, schema] of Object.entries(plan.schemas).sort()) {
    const nonNull = notNullColumns(schema), columns: DumpColumn[] = [["id", "text", true], ["version", "int", true], ["created_at", "timestamp", true], ["updated_at", "timestamp", true], ["author_id", "text", false]];
    if (schema.publishing) columns.push(["status", "text", true], ["published_at", "timestamp", false]);
    for (const [name, type] of Object.entries(schema.fields)) {
      if (type === "geo") columns.push([`${name}_lat`, "real", false], [`${name}_lng`, "real", false]);
      else if (!columns.some(c => c[0] === name)) columns.push([name, kind(type), nonNull.has(name)]);
    }
    add(name, "id", columns);
    if (sq && schema.search?.length) after.push(`INSERT INTO ${ident(`_mantle_fts_${name}`)}(${ident(`_mantle_fts_${name}`)}) VALUES('rebuild')`);
    if (sq) for (const [field, type] of Object.entries(schema.fields)) if (type === "geo") { const tree = ident(`_mantle_geo_${name}_${field}`), lat = ident(`${field}_lat`), lng = ident(`${field}_lng`); after.push(`DELETE FROM ${tree}`, `INSERT INTO ${tree} SELECT _rid,${lat},${lat},${lng},${lng} FROM ${ident(name)} WHERE ${lat} IS NOT NULL AND ${lng} IS NOT NULL`); }
  }
  if (site) {
    add("site_config", "key", [["key", "text", true], ["value", "text", true]]);
    add("media_assets", "id", [["id", "text", true], ["created_at", "int", true], ["owner_id", "text", false], ["alt", "text", false], ["caption", "text", false], ["variants", "text", true], ["metadata", "text", false]]);
    add("pending_media_uploads", "id", [["id", "text", true], ["record", "text", true], ["expires_at", "int", true]]);
  }
  if (auth) {
    const session = getAuthTables(auth).session?.modelName;
    const serial = auth.advanced?.database?.generateId === "serial", uuid = auth.advanced?.database?.generateId === "uuid";
    for (const [name, table] of orderedTables(auth)) {
      if (name === session) { omitted.push(name); continue; }
      const columns: DumpColumn[] = [["id", serial ? "int" : uuid ? "uuid" : "text", true]];
      for (const [column, field] of Object.entries(table.fields)) if (column !== "id") {
        const sessionLink = field.references?.model === session;
        if (sessionLink && (field.required !== false || field.references?.onDelete !== "set null")) throw new Error(`Portable dump refuses required/non-SET-NULL session reference ${name}.${column}.`);
        const type = sessionLink ? "session" : field.references?.field === "id" && serial ? "int" : field.references?.field === "id" && uuid ? "uuid" : field.type === "date" ? "authdate" : field.type === "boolean" ? "bool" : field.type === "number" ? "int" : field.type === "json" ? "json" : "text";
        columns.push([column, type, field.required !== false]);
      }
      add(name, "id", columns);
      if (!sq && serial) after.push(`SELECT setval(pg_get_serial_sequence('${ident(name).replaceAll("'", "''")}','id'),COALESCE(MAX(id),1),MAX(id) IS NOT NULL) FROM ${ident(name)}`);
    }
  }
  const descriptor: DumpPlan = { dialect: sq ? "sqlite" : "postgres", version, tables, omitted, empty: [...tables.map(t => t.name), ...omitted].map(name => `SELECT 1 FROM ${ident(name)} LIMIT 1`), after };
  const driver = driverFor(target), contracts = target.endsWith("postgres") ? 'import type { Postgres as Database } from "@aotter/mantle-next/contracts";' : databaseImport(target);
  return { "transfer.ts": `${contracts}\nimport {exportStore as dump,importStore as restore,type DumpStorage} from "@aotter/mantle-next/transfer";\nimport * as DRIVER from "@aotter/mantle-next/driver/${driver}";\nexport const transferPlan=${q(descriptor)} as const;\nfunction storage(db:Database):DumpStorage {const query=(sql:string,values:any[])=>DRIVER.read(db,sql,values);return {read:query,write:query${driver !== "d1" ? ",transaction:fn=>DRIVER.transaction(db,tx=>fn(storage(tx)))" : ""}};}\nexport function exportStore(db:Database){return dump(storage(db),transferPlan);}\nexport function importStore(db:Database,stream:ReadableStream<Uint8Array>){return restore(storage(db),transferPlan,stream);}\n` };
}
