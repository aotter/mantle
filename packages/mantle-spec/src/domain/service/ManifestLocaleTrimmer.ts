import { isMap, isSeq, parseAllDocuments } from "yaml";

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

const LOCALE_KEY = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;

/** Returns the manifest text unchanged when nothing needed trimming. */
export function trimManifestLocales(text: string, locales: readonly string[]): string {
  const documents = parseAllDocuments(text);
  if (documents.some((document) => document.errors.length > 0)) {
    throw new ManifestLocaleTrimError("invalid_yaml", "manifest is not valid YAML.");
  }
  let changed = false;
  for (const document of documents) changed = trimNode(document.contents, locales) || changed;
  return changed ? documents.map(String).join("---\n") : text;
}

function trimNode(node: unknown, locales: readonly string[]): boolean {
  if (isSeq(node)) {
    let changed = false;
    for (const item of node.items) changed = trimNode(item, locales) || changed;
    return changed;
  }
  if (!isMap(node)) return false;
  let changed = false;
  for (const pair of node.items) {
    const key = scalarValue(pair.key);
    const localized = key === "title" || key === "description" ? localeMap(pair.value) : null;
    if (!localized) {
      changed = trimNode(pair.value, locales) || changed;
      continue;
    }
    const available = new Set(localized.items.map((item) => scalarValue(item.key)));
    const missing = locales.filter((locale) => !available.has(locale));
    if (missing.length > 0) {
      throw new ManifestLocaleTrimError(
        "unsupported_locale",
        `manifest does not support locales: ${missing.join(", ")}`,
      );
    }
    const before = localized.items.length;
    localized.items = localized.items.filter((item) => locales.includes(scalarValue(item.key)));
    changed ||= localized.items.length !== before;
  }
  return changed;
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
    if (!LOCALE_KEY.test(scalarValue(item.key))) return null;
  }
  return map;
}

function scalarValue(node: unknown): string {
  return String((node as { value?: unknown } | null)?.value ?? "");
}
