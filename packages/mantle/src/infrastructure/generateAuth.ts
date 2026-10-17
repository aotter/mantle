/** Selected Auth generation; the compiler and request DTO remain shared with the bare entry. */
import type { BetterAuthOptions } from "better-auth/types";
import { generateFromSources as generate, type GenerateRequest } from "./generate.js";
import { authSchemaSql } from "./authSchema.js";
/** One or more Better Auth instances (each with its own table names); their DDL is merged. */
export function generateFromSources(request: GenerateRequest & { readonly auth?: BetterAuthOptions | readonly BetterAuthOptions[] }) {
  const instances = request.auth ? [request.auth].flat() : [];
  return generate(request, instances.length ? () => authSql(instances, request.target.endsWith("postgres") ? "postgres" : "sqlite") : undefined);
}
function authSql(instances: readonly BetterAuthOptions[], dialect: "postgres" | "sqlite"): string[] {
  for (const options of instances) {
    const ids = (options.plugins ?? []).map(plugin => plugin.id);
    // Offline OAuth grants outlive sessions; without the revocation plugin a password reset or ban would not end them. mcp() spreads oauthProvider, id included.
    if (ids.includes("oauth-provider") && !ids.includes("mantle-oauth-grant-revocation") /* oauthGrantRevocation().id */) throw new Error("Better Auth has an OAuth provider (oauthProvider or mcp) without oauthGrantRevocation(): add it from @aotter/mantle/auth/oauth to the plugins, so a password reset, an admin ban or session revocation ends that user's OAuth grants.");
  }
  if (instances.length > 1) refuseSharedPluginMappings(instances);
  const statements = [...new Set(instances.flatMap(options => authSchemaSql(options, dialect)))];
  // CREATE TABLE IF NOT EXISTS would silently keep the first of two different definitions.
  // Identical statements are already merged, so a repeated table name means two different definitions.
  const tables = statements.map(statement => /^CREATE TABLE IF NOT EXISTS ("(?:[^"]|"")+")/.exec(statement)?.[1]).filter(Boolean);
  const twice = tables.find((table, i) => tables.indexOf(table) !== i);
  if (twice) throw new Error(`Better Auth instances define table ${twice} differently; give each instance its own table names (user.modelName, session.modelName, ...).`);
  return statements;
}
type PluginSchema = Record<string, { modelName?: string; fields?: Record<string, unknown> }>;
// Plugins whose factory hands back one module-level schema object (mergeSchema writes `schema` options into it).
const sharedSchemaPlugins = new Set(["jwt", "admin", "anonymous", "phone-number", "siwe", "two-factor", "username", "device-authorization", "oauth-provider"]);
/** Names a plugin's tables and fields resolve to, keyed `table` / `table.field`; only mappings that differ from the key are listed. */
function mapped(schema: PluginSchema): Map<string, string> {
  const names = new Map<string, string>();
  for (const [table, model] of Object.entries(schema)) {
    if (model.modelName && model.modelName !== table) names.set(table, model.modelName);
    for (const [field, type] of Object.entries(model.fields ?? {})) {
      const name = (type as { fieldName?: string }).fieldName;
      if (name && name !== field) names.set(`${table}.${field}`, name);
    }
  }
  return names;
}
/** Better Auth plugin factories share their schema object, so differing plugin field/model mappings across instances in one Worker override each other. */
function refuseSharedPluginMappings(instances: readonly BetterAuthOptions[]) {
  const byPlugin = new Map<string, { index: number; schema: PluginSchema }[]>();
  instances.forEach((options, index) => (options.plugins ?? []).forEach(plugin => {
    const schema = (plugin as { schema?: PluginSchema }).schema;
    if (schema && sharedSchemaPlugins.has(plugin.id)) byPlugin.set(plugin.id, [...(byPlugin.get(plugin.id) ?? []), { index, schema }]);
  }));
  for (const [id, uses] of byPlugin) {
    const fail = (reason: string, a: number, b: number): never => { throw new Error(`Better Auth plugin ${id} is used by instances ${a} and ${b} (--auth order, from 0) and ${reason}. Plugin factories share their schema object, so differing plugin field/model mappings across instances in one Worker override each other: pass an explicit \`schema\` mapping to ${id}() in every instance and give each instance its own copy right after constructing it, \`{ ...plugin, schema: structuredClone(plugin.schema) }\`, or keep ${id} at its defaults and separate the instances by core table names.`); };
    const names = uses.map(use => mapped(use.schema));
    for (const [i, a] of uses.entries()) for (const [j, b] of uses.entries()) {
      if (j <= i) continue;
      if (a.schema === b.schema && names[i]!.size) fail("they hold the same schema object, which carries a non-default mapping", a.index, b.index);
      for (const [key, name] of names[i]!) if (names[j]!.get(key) === name) fail(`both resolve ${key} to "${name}" (one instance inherited the other's mapping)`, a.index, b.index);
    }
  }
}
export type { GenerateRequest } from "./generate.js";
