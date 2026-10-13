/** Public generation targets and result envelope. */
export type Target = "bun-sqlite" | "bun-postgres" | "cloudflare-d1" | "cloudflare-postgres";
export interface GenerateDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export type GenerateResult =
  | { readonly ok: true; readonly files: Readonly<Record<string, string>>; readonly refProcedures: readonly string[] }
  | { readonly ok: false; readonly diagnostics: readonly GenerateDiagnostic[] };

