import { isMap, parseAllDocuments, visit } from "yaml";
import { toCanonicalLocale } from "./LocaleCanonicalizer.js";

/**
 * Drops every locale a project did not select from a manifest's localized
 * `title` / `description` maps, preserving the rest of the document byte for
 * byte. Provisioning calls this so a generated project's manifest carries
 * only the locales it was created with.
 *
 * Lives in spec because manifest text is spec's material: it owns the YAML
 * dependency and the shape of a localized-text node.
 */
export class ManifestLocaleTrimError extends Error {
  constructor(
    readonly reason: "invalid_yaml" | "unsupported_locale",
    message: string,
  ) {
    super(message);
    this.name = "ManifestLocaleTrimError";
  }
}

/** Returns the manifest text unchanged when nothing needed trimming. */
export function trimManifestLocales(text: string, locales: readonly string[]): string {
  const documents = parseAllDocuments(text);
  if (documents.some((document) => document.errors.length > 0)) {
    throw new ManifestLocaleTrimError("invalid_yaml", "manifest is not valid YAML.");
  }
  let changed = false;
  for (const document of documents) {
    visit(document, {
      Pair(_key, pair) {
        const key = scalarValue(pair.key);
        const localized = key === "title" || key === "description" ? localeMap(pair.value) : null;
        if (!localized) return;
        const entries = localized.items.map((item) => ({ item, locale: canonicalLocale(item.key) as string }));
        const available = new Set(entries.map(({ locale }) => locale));
        const missing = locales.filter((locale) => !available.has(locale));
        if (missing.length > 0) {
          throw new ManifestLocaleTrimError(
            "unsupported_locale",
            `manifest does not support locales: ${missing.join(", ")}`,
          );
        }
        localized.items = entries.filter(({ locale }) => locales.includes(locale)).map(({ item }) => item);
        changed ||= localized.items.length !== entries.length;
        return visit.SKIP;
      },
    });
  }
  return changed ? documents.map(String).join("---\n") : text;
}

interface LocaleMapNode {
  items: { key: unknown; value: unknown }[];
}

/** A localized-text node maps locale keys to scalar strings, nothing else. */
function localeMap(node: unknown): LocaleMapNode | null {
  if (!isMap(node)) return null;
  const map = node as unknown as LocaleMapNode;
  if (map.items.length === 0) return null;
  for (const item of map.items) {
    if (typeof (item.value as { value?: unknown } | null)?.value !== "string") return null;
    if (!canonicalLocale(item.key)) return null;
  }
  return map;
}

function canonicalLocale(node: unknown): string | null {
  try {
    return toCanonicalLocale(scalarValue(node));
  } catch {
    return null;
  }
}

function scalarValue(node: unknown): string {
  return String((node as { value?: unknown } | null)?.value ?? "");
}
