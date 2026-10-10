/**
 * Schema readers (ADR-0043): `store.db.<schema>.get | first | find`. A reader walks its query once (`walkRead`) into a shape key and
 * the bind values; the first call of a shape converts and compiles it, and every later call only checks its values, binds and runs.
 * The memo holds compiled artifacts, one per request shape, bounded and shared by a Store and every `as()` of it.
 */
import { DiagnosticError, runtimeDiagnostic } from "../../spec/kernel/index.js";
import { readerName, readerNameProblems } from "../../spec/domain/index.js";
import type { MantleStore, CallerStore, SchemaReader, StoreDb, StoreRow, StoreSelectResult } from "../store.js";
import type { Program } from "../sql/run.js";
import type { StoreSchemas } from "./json.js";

const invalid = (message: string) => new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message }));

/** A request shape compiled once: its stable Program (so the compile, paging and print caches hit), the row decoder and the binds' types. */
export interface Shape {
  readonly program: Program;
  readonly binding: string;
  readonly decode: (r: StoreRow) => StoreRow;
  readonly types: readonly string[];
  readonly whats: readonly string[];
}

export interface ReaderSet {
  /** shape key to compiled shape; FIFO, at most `READER_SHAPES` */
  readonly memo: Map<string, Shape>;
  /** a null-prototype object with one non-enumerable getter per reader name */
  readonly proto: object;
  /** Schema key to its reader name */
  readonly byKey: ReadonlyMap<string, string>;
}

/** Shapes kept per Store. A request-shape cache like `pagedCache`: it does not hold the compile cache's "no request input grows it" invariant, so it is bounded. */
export const READER_SHAPES = 256;

export type ReadKind = "get" | "first" | "find";
/** Runs one read of one Schema (by key) for one bound Store; `q` is the caller's query, untrusted. */
export type ReadRun = (schema: string, kind: ReadKind, q: unknown) => Promise<StoreSelectResult>;

interface Bound {
  readonly run: ReadRun;
  readonly set: ReaderSet;
  readonly readers: Record<string, SchemaReader>;
}

const BIND = Symbol("mantle.db");
const bound = (db: unknown): Bound | undefined => (typeof db === "object" && db !== null && Object.hasOwn(db, BIND) ? (db as Record<symbol, Bound>)[BIND] : undefined);

export function createReaderSet(schemas: StoreSchemas): ReaderSet {
  const entries = Object.entries(schemas).map(([key, def]) => [key, def.name ?? key] as const);
  // boot refuses these first (`SCHEMA_READER_NAME_COLLISION`); a Store built without it must not shadow a Schema either
  const problem = readerNameProblems(entries.map(([, name]) => name))[0];
  if (problem) throw invalid(problem.message);
  const byKey = new Map(entries.map(([key, name]) => [key, readerName(name)]));
  const proto = Object.create(null) as object;
  byKey.forEach((name, key) => Object.defineProperty(proto, name, {
    enumerable: false,
    get(this: unknown) {
      const b = bound(this);
      if (!b) throw invalid("A Schema reader is read from a Store's db.");
      return b.readers[key] ?? (b.readers[key] = makeReader(b.run, key));
    },
  }));
  return { memo: new Map(), proto, byKey };
}

/** The `db` of one bound Store: no own enumerable keys, no `then`, and a reader only through the binding it was made for. */
export function dbFor(set: ReaderSet, run: ReadRun): StoreDb {
  const db = Object.create(set.proto) as StoreDb;
  Object.defineProperty(db, BIND, { value: { run, set, readers: Object.create(null) } satisfies Bound });
  return db;
}

/** The reader of a Schema by its declared name (any case), for code that holds a name rather than a property: Admin, the translation check. */
export function readerOf(db: StoreDb, schema: string): SchemaReader {
  const b = bound(db);
  if (!b) throw invalid("A Schema reader is read from a Store's db.");
  const name = b.set.byKey.get(String(schema).toLowerCase());
  if (name === undefined) throw invalid(`Unknown Schema '${String(schema)}'.`);
  return db[name]!;
}

/** Test hook: how many shapes the Store's reader memo holds. */
export const readerMemoSize = (store: MantleStore | CallerStore): number => bound(store.db)?.set.memo.size ?? 0;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function makeReader(run: ReadRun, key: string): SchemaReader {
  return {
    async get(id, options) {
      if (typeof id !== "string") throw invalid("A reader get takes an entry id.");
      if (options !== undefined && !isObject(options)) throw invalid("A reader get takes an object.");
      const given = Object.keys(options ?? {});
      const bad = given.find((k) => k !== "columns");
      if (bad) throw invalid(`Unknown reader get key '${bad}'.`);
      const columns = given.length ? (options as Record<string, unknown>)["columns"] : undefined;
      const where: Record<string, unknown> = Object.create(null);
      where["id"] = id;
      const orderBy: Record<string, unknown> = Object.create(null);
      orderBy["id"] = "asc";
      const q: Record<string, unknown> = Object.create(null);
      q["where"] = where;
      if (columns !== undefined) q["columns"] = columns;
      q["orderBy"] = orderBy;
      return ((await run(key, "get", q)).rows[0] ?? null) as never;
    },
    async first(query) {
      return ((await run(key, "first", query)).rows[0] ?? null) as never;
    },
    find: (query) => run(key, "find", query) as never,
  };
}
