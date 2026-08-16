import type { Entry } from "@aotter/mantle-spec";
import type { MediaAsset } from "@aotter/mantle-runtime";

export interface MediaAssetResolver {
  resolveMany(ids: readonly string[]): Promise<ReadonlyMap<string, MediaAsset>>;
}

/**
 * Extract media asset references from entry data by convention.
 * Starters use `coverAssetId`, `imageAssetId`, nested `{ assetId }`, etc.
 * The schema-level source of truth remains `x-mantle-ref: media_assets`;
 * this convention keeps the render path schema-agnostic until the
 * manifest compiler exposes field metadata at runtime.
 */
export function collectMediaAssetIds(value: unknown): readonly string[] {
  const out: string[] = [];
  collect(value, out);
  return [...new Set(out)];
}

export async function resolveMediaAssetsForEntries(
  resolver: MediaAssetResolver | null,
  entries: readonly Entry[],
): Promise<ReadonlyMap<string, MediaAsset> | undefined> {
  if (!resolver) return undefined;
  const ids = collectMediaAssetIds(entries.map((entry) => entry.data));
  if (ids.length === 0) return undefined;
  return resolver.resolveMany(ids);
}

function collect(value: unknown, out: string[]): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === "string" &&
      (key === "assetId" || key.endsWith("AssetId")) &&
      child.length > 0
    ) {
      out.push(child);
      continue;
    }
    if (Array.isArray(child) && key.endsWith("AssetIds")) {
      for (const item of child) {
        if (typeof item === "string" && item.length > 0) out.push(item);
      }
      continue;
    }
    collect(child, out);
  }
}
