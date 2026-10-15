/** Selected Auth generation; the compiler and request DTO remain shared with the bare entry. */
import type { BetterAuthOptions } from "better-auth/types";
import { generateFromSources as generate, type GenerateRequest } from "./generate.js";
import { authSchemaSql } from "./authSchema.js";
import { OAUTH_GRANT_REVOCATION } from "../auth/oauth.js";
/** One or more Better Auth instances (each with its own table names); their DDL is merged. */
export function generateFromSources(request: GenerateRequest & { readonly auth?: BetterAuthOptions | readonly BetterAuthOptions[] }) {
  const instances = request.auth ? [request.auth].flat() : [];
  return generate(request, instances.length ? () => authSql(instances, request.target.endsWith("postgres") ? "postgres" : "sqlite") : undefined);
}
function authSql(instances: readonly BetterAuthOptions[], dialect: "postgres" | "sqlite"): string[] {
  for (const options of instances) {
    const ids = (options.plugins ?? []).map(plugin => plugin.id);
    // Offline OAuth grants outlive sessions; without the revocation plugin a password reset or ban would not end them.
    if (ids.some(id => id === "oauth-provider" || id === "mcp") && !ids.includes(OAUTH_GRANT_REVOCATION)) throw new Error("Better Auth has an OAuth provider (oauthProvider or mcp) without oauthGrantRevocation(): add it from @aotter/mantle/auth/oauth to the plugins, so a password reset, an admin ban or session revocation ends that user's OAuth grants.");
  }
  const statements = [...new Set(instances.flatMap(options => authSchemaSql(options, dialect)))];
  // CREATE TABLE IF NOT EXISTS would silently keep the first of two different definitions.
  // Identical statements are already merged, so a repeated table name means two different definitions.
  const tables = statements.map(statement => /^CREATE TABLE IF NOT EXISTS ("(?:[^"]|"")+")/.exec(statement)?.[1]).filter(Boolean);
  const twice = tables.find((table, i) => tables.indexOf(table) !== i);
  if (twice) throw new Error(`Better Auth instances define table ${twice} differently; give each instance its own table names (user.modelName, session.modelName, ...).`);
  return statements;
}
export type { GenerateRequest } from "./generate.js";
