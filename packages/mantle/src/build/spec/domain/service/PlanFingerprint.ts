import type { RuntimePlan } from "../model/RuntimePlan.js";

/** JSON with sorted keys, so equal plans serialize to equal text whatever built them. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** 32-bit FNV-1a (hex): a short deterministic name, not a security boundary. */
export const fnv = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0, 2166136261).toString(16).padStart(8, "0");

/** SHA-256 (hex) of the plan without its own fingerprint: it crosses a trust boundary, so it is cryptographic (ADR-0032 decision 10). */
export async function planFingerprint(plan: Omit<RuntimePlan, "fingerprint">): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(plan)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
