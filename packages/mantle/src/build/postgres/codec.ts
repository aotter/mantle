/** Native PostgreSQL column and cast type names. */
import { SqlRefusal as Refused, parseNumeric } from "../spec/domain/index.js";

/** A Mantle type as a PostgreSQL type name, for a column and for a cast. */
export function pgType(type: string): string {
  const num = parseNumeric(type);
  if (num) return `numeric(${num.p}, ${num.s})`;
  switch (type) {
    case "text": case "geo": return "text";
    case "json": return "jsonb";
    case "int4": return "int4";
    case "int8": case "integer": return "int8";
    case "float8": case "real": return "float8";
    case "bool": return "bool";
    case "timestamptz": return "timestamptz";
    case "date": return "date";
  }
  throw new Refused("SQL_TYPE", `unknown type ${type}`);
}
