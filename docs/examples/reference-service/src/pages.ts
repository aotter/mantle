/** App-owned keysets for computed orderings outside the generator's paging proofs. */
import { ContractError, type Caller } from "@aotter/mantle/contracts";
import type { Handle } from "@aotter/mantle/driver/d1";
import search from "../generated/views/search-items.js";
import sales from "../generated/views/sales-by-item.js";
import { validate as searchInput } from "../generated/validation/views/search-items.js";
import { validate as salesInput } from "../generated/validation/views/sales-by-item.js";
const fail = (): never => { throw new ContractError("INPUT_VALIDATION_FAILED", "Invalid page input or cursor.", "reference/paging"); };
export function pageOptions(input: { limit?: number; cursor?: string }) {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail();
  let key: unknown;
  if (input.cursor) { try { key = JSON.parse(decodeURIComponent(input.cursor)); } catch { fail(); } }
  if (key !== undefined && !Array.isArray(key)) fail();
  return { limit, key: key as unknown[] | undefined };
}
const cursor = (key: unknown[]) => encodeURIComponent(JSON.stringify(key));
export async function searchPage(db: Handle, caller: Caller, input: { q: string }, options: { limit?: number; cursor?: string } = {}) {
  const { limit, key } = pageOptions(options);
  if (typeof input.q !== "string" || !input.q.length || input.q.includes("\0")) fail();
  if (key && (key.length !== 5 || key[0] !== "search-items" || key[1] !== input.q || typeof key[2] !== "number" || !Number.isFinite(key[2]) || typeof key[3] !== "string" || typeof key[4] !== "string")) fail();
  const values = { q: input.q, afterRank: key?.[2] ?? null, afterName: key?.[3] ?? null, afterId: key?.[4] ?? null, cap: limit + 1 };
  searchInput(values);
  const rows = await search(db, caller, values as Parameters<typeof search>[2]);
  const extra = rows.length > limit, page = rows.slice(0, limit), last = page.at(-1);
  return { rows: page.map(({ rank: _rank, ...row }) => row), ...(extra && last ? { nextCursor: cursor(["search-items", input.q, last.rank, last.name, last.id]) } : {}) };
}
export async function salesPage(db: Handle, caller: Caller, input: unknown, options: { limit?: number; cursor?: string } = {}) {
  const { limit, key } = pageOptions(options);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) fail();
  if (key && (key.length !== 3 || key[0] !== "sales-by-item" || typeof key[1] !== "number" || !Number.isSafeInteger(key[1]) || typeof key[2] !== "string")) fail();
  const values = { afterUnits: key?.[1] ?? null, afterName: key?.[2] ?? null, cap: limit + 1 };
  salesInput(values);
  const rows = await sales(db, caller, values as Parameters<typeof sales>[2]);
  const extra = rows.length > limit, page = rows.slice(0, limit), last = page.at(-1);
  return { rows: page, ...(extra && last ? { nextCursor: cursor(["sales-by-item", last.units, last.name]) } : {}) };
}
