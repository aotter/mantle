/** Helpers of generated input validation: the checks themselves are compiled per operation, no schema is read at request time. */
import { invalid } from "./surface.js";

/** INPUT_VALIDATION_FAILED at the JSON pointer `path`. */
export function fail(path: string, message: string): never { return invalid(message, path); }
/** JSON equality for `enum`. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}
const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const tests = { string: (value: unknown) => typeof value === "string", number: Number.isFinite, integer: Number.isSafeInteger, boolean: (value: unknown) => typeof value === "boolean", object: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) };
const is = (value: unknown, path: string, type: keyof typeof tests, nullable?: boolean): void => { if (!(tests[type](value) || nullable && value === null)) fail(path, "Expected " + type + (nullable ? " or null." : ".")); };
/** The check of the publishing transitions' input `{id, expectedVersion}` at `path`. */
export function transition(path: string, raw: unknown): Record<string, unknown> {
  const keys = ["id", "expectedVersion"];
  is(raw, path, "object");
  const object = raw as Record<string, unknown>;
  for (const key of keys) if (!Object.hasOwn(object, key)) fail(path + "/" + key, "Required field is missing.");
  is(object.id, path + "/id", "string");
  if (object.id === "") fail(path + "/id", "Value violates minLength.");
  is(object.expectedVersion, path + "/expectedVersion", "integer");
  if (object.expectedVersion as number < 1) fail(path + "/expectedVersion", "Value violates minimum.");
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail(path + "/" + pointer(key), "Unknown field.");
  return object;
}
function number(raw: string, path: string, integer: boolean): number { const value = Number(raw); if (raw.trim() === "" || !Number.isFinite(value) || integer && !Number.isSafeInteger(value)) fail(path, "Expected a valid number."); return value; }
function boolean(raw: string, path: string): boolean { if (raw !== "true" && raw !== "false") fail(path, "Expected true or false."); return raw === "true"; }

/**
 * A View's query string: each declared field (typed `boolean`, `integer` or `number` when the input says so) is read
 * from `params`, then validated; `limit` and `cursor` are the paging options. `operation` is `views/<name>`.
 */
export function query(params: URLSearchParams, validate: (raw: unknown) => Record<string, unknown>, operation: string, fields: ReadonlyArray<readonly [key: string, type?: "boolean" | "integer" | "number"]>): { input: Record<string, unknown>; limit?: number; cursor?: string } {
  const input: Record<string, unknown> = {};
  for (const [key, type] of fields) {
    const raw = params.get(key), path = operation + "/input/" + pointer(key);
    if (raw !== null) Object.defineProperty(input, key, { value: type === "boolean" ? boolean(raw, path) : type ? number(raw, path, type === "integer") : raw, enumerable: true });
  }
  const limit = params.get("limit"), cursor = params.get("cursor");
  return { input: validate(input), ...(limit === null ? {} : { limit: number(limit, operation + "/limit", true) }), ...(cursor ? { cursor } : {}) };
}
