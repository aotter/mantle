/** Selected Auth generation; the compiler and request DTO remain shared with the bare entry. */
import type { BetterAuthOptions } from "better-auth/types";
import { generateFromSources as generate, type GenerateRequest } from "./generate.js";
import { authSchemaSql } from "./authSchema.js";
export function generateFromSources(request: GenerateRequest & { readonly auth?: BetterAuthOptions }) {
  return generate(request, request.auth ? () => authSchemaSql(request.auth!, request.target.endsWith("postgres") ? "postgres" : "sqlite") : undefined);
}
export type { GenerateRequest } from "./generate.js";
