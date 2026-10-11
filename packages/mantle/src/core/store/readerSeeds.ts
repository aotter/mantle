/** Finite generated reader shapes, adopted into the Store's existing memo on successful first use. */
import type { LoweredView, SqlNode } from "../../spec/domain/index.js";
import type { MantleDialect } from "../dialect.js";
import { compileProgram } from "../sql/compile.js";
import { lowerView, seedLoweredView } from "../sql/lowered.js";
import { StoreJson, rowDecoder, walkRead, type Column, type StoreSchemas } from "./json.js";
import type { Shape } from "./readers.js";

export interface ReaderSeed {
  readonly query: Readonly<Record<string, unknown>>;
  readonly inputs: Readonly<Record<string, string>>;
  readonly columns: readonly Column[];
  readonly binding: string;
  readonly types: readonly string[];
  readonly whats: readonly string[];
  readonly tags: readonly string[];
  readonly lowered: Readonly<Partial<Record<"caller" | "trusted", LoweredView>>>;
}

/** Generation uses the ordinary converter, policy compiler and dialect printer. */
export function lowerReaderSeeds(schemas: StoreSchemas, dialect: MantleDialect): Record<string, ReaderSeed> {
  const result: Record<string, ReaderSeed> = Object.create(null);
  if (dialect.restricted || !dialect.print) return result;
  for (const key of Object.keys(schemas).sort()) {
    let defaults: ReaderSeed | undefined;
    for (const kind of ["get", "first", "find"] as const) {
      const query = kind === "get" ? { where: { id: "generated-reader" }, orderBy: { id: "asc" } } : {};
      // These shapes have at most one scalar bind, so IN padding and adapter binding limits cannot alter their key.
      const w = walkRead(schemas[key]!, kind, query, 100);
      const mk = `${key}\u0000${w.key}`;
      if (kind === "find" && defaults) { result[mk] = defaults; continue; }
      const json = new StoreJson(schemas, dialect.codec);
      const s = json.read({ from: key, ...w.query } as never);
      const program = { inputs: json.inputs, ir: [s.ir] };
      const lowered = Object.fromEntries((["caller", "trusted"] as const).flatMap(mode => {
        const v = lowerView({ schemas, dialect }, program, mode);
        return v ? [[mode, kind === "get" ? { ...v, paged: {} } : v]] : [];
      }));
      // A refused mode must use the ordinary path, rather than a partial generated shape.
      if (!Object.hasOwn(lowered, "caller") || !Object.hasOwn(lowered, "trusted")) continue;
      const seed = { query: w.query, inputs: json.inputs, columns: s.columns, binding: `${s.from}:${s.order.column.col}:${s.order.dir}`, types: json.types, whats: json.whats, tags: json.tags, lowered };
      result[mk] = seed;
      if (kind === "first") defaults = seed;
    }
  }
  return result;
}

/** A genuine, stable IR array: its canonical converter runs only if an unlowered paging shape needs the AST. */
export function readerShape(seed: ReaderSeed, schemas: StoreSchemas, schema: string, dialect: MantleDialect): Shape {
  let ast: SqlNode | undefined;
  const ir: SqlNode[] = new Array(1);
  Object.defineProperty(ir, "0", { enumerable: true, get: () => ast ??= new StoreJson(schemas, dialect.codec).read({ from: schema, ...seed.query } as never).ir });
  const program = { kind: "view" as const, inputs: seed.inputs, ir };
  const env = { schemas, dialect };
  const installs = (["caller", "trusted"] as const).map(mode => seedLoweredView(env, program, mode, seed.lowered[mode]!, () => compileProgram(ir, { schemas, dialect, inputs: seed.inputs, kind: "view", mode })[0]!));
  for (const install of installs) install();
  return { program, binding: seed.binding, decode: rowDecoder(seed.columns, dialect.codec), types: seed.types, whats: seed.whats };
}
