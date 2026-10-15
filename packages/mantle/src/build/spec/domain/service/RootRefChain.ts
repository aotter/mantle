import type { JsonSchema } from "../model/ManifestGrammar.js";

/** The schema a local JSON pointer `ref` names in `root`, or undefined. */
export function lookupLocalRef(root: JsonSchema, ref: unknown): JsonSchema | undefined {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let value: unknown = root;
  try {
    for (const key of decodeURIComponent(ref.slice(2)).split("/").map(key=>key.replace(/~1/g,"/").replace(/~0/g,"~"))) value = value && typeof value === "object" && Object.hasOwn(value,key) ? (value as Record<string,unknown>)[key] : undefined;
  } catch { return undefined; }
  return value && typeof value === "object" ? value as JsonSchema : undefined;
}

/**
 * `input` and each schema its root `$ref` chain reaches, in order: validation applies all of them to the root value.
 * Undefined when the chain does not resolve or cycles.
 */
export function rootRefChain(input: JsonSchema): JsonSchema[] | undefined {
  const chain: JsonSchema[] = [];
  for (let schema: JsonSchema | undefined = input; schema !== undefined; schema = lookupLocalRef(input, schema.$ref)) {
    if (chain.includes(schema)) return undefined;
    chain.push(schema);
    if (schema.$ref === undefined) return chain;
  }
  return undefined;
}
