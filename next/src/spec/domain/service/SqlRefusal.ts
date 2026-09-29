import type { SqlDiagnosticCode } from "../model/SqlIr.js";

/**
 * Thrown inside the SQL allowlist and converted to a `SqlDiagnostic` at the
 * boundary (`validateIr`, `compileSql`); it never escapes the spec module.
 */
export class SqlRefusal extends Error {
  code: SqlDiagnosticCode;
  offset?: number;
  /**
   * The keyword the refusal is about. The parser gives no position for a
   * clause key, so the CLI finds this in the source.
   */
  keyword?: RegExp;
  constructor(code: SqlDiagnosticCode, message: string, offset?: number, keyword?: RegExp) {
    super(message);
    this.code = code;
    this.offset = offset;
    this.keyword = keyword;
  }
}
