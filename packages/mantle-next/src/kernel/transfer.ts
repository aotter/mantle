/** Deployment-only portable storage. Never import this entry from request startup. */
import { createHash } from "node:crypto";
import { ContractError } from "./contracts.js";
import { encodeDate, encodeTimestamptz, isoTimestamptz } from "./scalars.js";

export type DumpColumn = readonly [name: string, kind: "text" | "int" | "real" | "bool" | "json" | "timestamp" | "date" | "authdate" | "session" | "uuid", required: boolean];
export interface DumpTable { readonly name: string; readonly key: string; readonly columns: readonly DumpColumn[]; readonly first: string; readonly next: string; readonly insert: readonly [prefix: string, values: readonly string[]]; }
export interface DumpPlan { readonly dialect: "sqlite" | "postgres"; readonly version: string; readonly tables: readonly DumpTable[]; readonly empty: readonly string[]; readonly after: readonly string[]; readonly omitted: readonly string[]; }
export interface DumpStorage {
  read(sql: string, values: any[]): PromiseLike<any[]> | any[];
  write(sql: string, values: any[]): PromiseLike<unknown> | unknown;
  transaction?<T>(fn: (storage: DumpStorage) => Promise<T>): Promise<T>;
}
const PAGE = 20, MAX_LINE = 1_048_576;
const fail = (message: string) => new ContractError("DUMP_INVALID", message, "store/import", { status: 400 });
const nativeJSON = JSON as typeof JSON & { rawJSON(text: string): unknown; isRawJSON(value: unknown): boolean };
const canonical = (value: any, depth = 0): any => {
  if (depth > 64) throw fail("JSON nesting exceeds 64 levels.");
  if (nativeJSON.isRawJSON?.(value)) return value;
  if (typeof value === "number" && !Number.isFinite(value)) throw fail("Non-finite number.");
  return Array.isArray(value) ? value.map(v => canonical(v, depth + 1)) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], depth + 1)])) : value;
};
/** Exact JSON numbers survive native parsing; binary64 must never mediate portable JSON. */
function jsonText(text: unknown): string {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_LINE || !nativeJSON.rawJSON) throw fail("Bounded exact JSON text/native JSON source support required.");
  const parsed = JSON.parse(text, ((_key: string, v: any, context: { source?: string }) => {
    if (typeof v !== "number") return v;
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(context?.source ?? "");
    if (!match) throw fail("Exact JSON numeric source unavailable.");
    let digits = (match[2]! + (match[3] ?? "")).replace(/^0+/, ""), exponent = BigInt(match[4] ?? "0") - BigInt(match[3]?.length ?? 0);
    if (!digits) return nativeJSON.rawJSON("0");
    const zeros = /0+$/.exec(digits)?.[0].length ?? 0; digits = digits.slice(0, digits.length - zeros); exponent += BigInt(zeros);
    return nativeJSON.rawJSON(match[1]! + digits + (exponent ? "e" + exponent : ""));
  }) as any);
  // JSON.parse discards duplicate keys. Refuse them before the portable projection can hide source data.
  const objects: (Set<string> | null)[] = [];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
    if (token[0] === "{") objects.push(new Set()); else if (token[0] === "[") objects.push(null);
    else if (token[0] === "}" || token[0] === "]") objects.pop();
    else if (/^\s*:/.test(text.slice(token.index! + token[0].length))) {
      const keys = objects.at(-1)!, key = JSON.parse(token[0]);
      if (keys?.has(key)) throw fail("Duplicate JSON object key."); keys?.add(key);
    }
  }
  return JSON.stringify(canonical(parsed));
}
const line = (value: unknown) => { const text = JSON.stringify(canonical(value)) + "\n"; if (Buffer.byteLength(text) > MAX_LINE) throw fail("Dump line exceeds 1 MiB."); return text; };
const fingerprint = (plan: DumpPlan) => createHash("sha256").update(line([plan.tables.map(t => [t.name, t.key, t.columns]), plan.omitted])).digest("hex");
const integer = (v: unknown): v is string => typeof v === "string" && v.length <= 20 && v !== "-0" && /^-?(0|[1-9]\d*)$/.test(v) && BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n;
function value(column: DumpColumn, v: any, source: boolean): any {
  const [, kind, required] = column;
  if (v === undefined) throw fail(`Missing ${column[0]}.`);
  if (v === null) { if (required) throw fail(`Missing ${column[0]}.`); return null; }
  if (source) {
    if (kind === "int") v = String(v);
    if (kind === "bool") { if (![true, false, 0, 1, 0n, 1n].includes(v)) throw fail(`Invalid ${column[0]}.`); v = v === true || v === 1 || v === 1n; }
    if (kind === "authdate") v = isoTimestamptz(v);
  }
  if (kind === "json") v = jsonText(v);
  if (kind === "session" || kind === "uuid" && (typeof v !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v)) || kind === "text" && typeof v !== "string" || kind === "int" && !integer(v) || kind === "real" && (typeof v !== "number" || !Number.isFinite(v)) || kind === "bool" && typeof v !== "boolean") throw fail(`Invalid ${column[0]}.`);
  if (kind === "timestamp" || kind === "authdate") { if (typeof v !== "string" || isoTimestamptz(v) !== v) throw fail(`Invalid timestamp ${column[0]}.`); }
  if (kind === "date") { if (typeof v !== "string") throw fail(`Invalid date ${column[0]}.`); encodeDate(v); }
  return v;
}
const keyOf = (table: DumpTable, row: any[]) => row[table.columns.findIndex(c => c[0] === table.key)];
const increasing = (table: DumpTable, before: any, after: any) => before === undefined || (table.columns.find(c => c[0] === table.key)![1] === "int" ? BigInt(after) > BigInt(before) : Buffer.compare(Buffer.from(after), Buffer.from(before)) > 0);
async function* rows(storage: DumpStorage, table: DumpTable) {
  let cursor: any;
  for (;;) {
    const page = await storage.read(cursor === undefined ? table.first : table.next, cursor === undefined ? [PAGE] : [cursor, PAGE]);
    for (const raw of page) {
      const row = table.columns.map(c => value(c, raw[c[0]], true)), next = keyOf(table, row);
      if (!increasing(table, cursor, next)) throw fail("Export keys are not strictly ordered.");
      cursor = next; yield row;
    }
    if (page.length < PAGE) return;
  }
}
/** Backpressure keeps one native page plus one NDJSON record in memory. The operator must freeze writes. */
export function exportStore(storage: DumpStorage, plan: DumpPlan): ReadableStream<Uint8Array> {
  const generate = async function* () {
    yield line({ format: "mantle-store", version: 1, fingerprint: fingerprint(plan), mantle: plan.version, dialect: plan.dialect, sessions: "omitted", omitted: plan.omitted, ignoredSessionLinks: plan.tables.flatMap(t=>t.columns.filter(c=>c[1]==="session").map(c=>[t.name,c[0]])) });
    let total = 0;
    for (const table of plan.tables) {
      yield line({ table: table.name }); const hash = createHash("sha256"); let count = 0;
      for await (const row of rows(storage, table)) { const text = line(row); hash.update(text); count++; yield text; }
      total += count; yield line({ end: table.name, rows: count, sha256: hash.digest("hex") });
    }
    yield line({ complete: true, tables: plan.tables.length, rows: total });
  };
  const iterator = generate(), encoder = new TextEncoder();
  return new ReadableStream({ async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); } catch (error) { controller.error(error); } }, async cancel() { await iterator.return(); } });
}
async function* records(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      for(let offset=0;offset<(done?1:value.byteLength);offset+=65536) {
        buffered += done ? decoder.decode() : decoder.decode(value.subarray(offset,offset+65536), { stream: true });
        let index: number;
        while ((index = buffered.indexOf("\n")) >= 0) { const text = buffered.slice(0, index); if (!text || Buffer.byteLength(text) > MAX_LINE) throw fail("Invalid dump line."); yield JSON.parse(text); buffered = buffered.slice(index + 1); }
        if (Buffer.byteLength(buffered) > MAX_LINE) throw fail("Dump line exceeds 1 MiB.");
      }
      if (done) { if (buffered) throw fail("Dump must end with a newline."); return; }
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
/** Exact static descriptors only; fresh, pre-provisioned storage. D1 failures require discarding the incomplete target. */
export async function importStore(storage: DumpStorage, plan: DumpPlan, stream: ReadableStream<Uint8Array>): Promise<{ rows: number }> {
  const input = records(stream), next = async () => { const record = await input.next(); if (record.done) throw fail("Truncated dump."); return record.value; };
  const object = (v:any) => { if(!v || typeof v!=="object" || Array.isArray(v)) throw fail("Expected a dump envelope."); return v; };
  let wrote = false;
  try {
    const header = object(await next());
    if (header.format !== "mantle-store" || header.version !== 1 || header.fingerprint !== fingerprint(plan) || header.sessions !== "omitted") throw fail("Dump format or descriptor fingerprint does not match.");
    const load = async (db: DumpStorage) => {
      for (const sql of plan.empty) if ((await db.read(sql, []))[0]) throw fail("Import target must be empty.");
      let total = 0;
      for (const table of plan.tables) {
        if (object(await next()).table !== table.name) throw fail("Unexpected or duplicate table section.");
        const hash = createHash("sha256"); let count = 0, key: any;
        const size = Math.min(PAGE, Math.floor(100 / table.columns.length)), batch: any[][] = [];
        if (!size) throw fail("A row exceeds the 100-parameter native limit.");
        const flush = async () => {
          if (!batch.length) return;
          const sql = table.insert[0] + batch.map((_, row) => "(" + table.insert[1].map((v, column) => v.replace("?", (plan.dialect === "postgres" ? "$" : "?") + (row * table.columns.length + column + 1))).join(",") + ")").join(",");
          wrote = true; await db.write(sql, batch.flat()); batch.length = 0;
        };
        let record = await next();
        while (Array.isArray(record)) {
          if (record.length !== table.columns.length) throw fail("Wrong column count.");
          const row = table.columns.map((c, i) => value(c, record[i], false)), current = keyOf(table, row);
          if (!increasing(table, key, current)) throw fail("Duplicate or unordered row key."); key = current;
          hash.update(line(row));
          const binds = table.columns.map((c, i) => row[i] === null ? null : plan.dialect === "sqlite" ? c[1] === "bool" ? Number(row[i]) : c[1] === "timestamp" ? encodeTimestamptz(row[i]) : c[1] === "date" ? encodeDate(row[i]) : row[i] : row[i]);
          batch.push(binds); count++; if (batch.length === size) await flush(); record = await next();
        }
        const digest = hash.digest("hex");
        if (object(record).end !== table.name || record.rows !== count || record.sha256 !== digest) throw fail("Table count or checksum does not match.");
        await flush();
        const restored = createHash("sha256"); let actual = 0;
        for await (const row of rows(db, table)) { restored.update(line(row)); actual++; }
        if (actual !== count || restored.digest("hex") !== digest) throw fail("Restored rows differ from portable values.");
        total += count;
      }
      const footer = object(await next());
      if (footer.complete !== true || footer.tables !== plan.tables.length || footer.rows !== total || !(await input.next()).done) throw fail("Invalid completion footer.");
      for (const sql of plan.after) await db.write(sql, []);
      return { rows: total };
    };
    return await (storage.transaction ? storage.transaction(load) : load(storage));
  } catch (cause) {
    if (wrote && !storage.transaction) throw new ContractError("IMPORT_INCOMPLETE", "Import failed; discard the incomplete target before retrying or switching bindings.", "store/import", { status: 409, cause, fields: { incomplete: true } });
    throw cause;
  } finally { await input.return(); }
}
