import type { Entry } from "@aotter/mantle-spec";
import type { WebSiteConfig } from "../model/WebSiteConfig.js";
import { absoluteUrl, appendMarkdownExt } from "./AbsoluteUrl.js";

/**
 * Built-in markdown serializer. Fixed format, applied to every entry
 * whose Schema produces a `content` field. Intentionally not user-
 * customizable — agents that consume `.md` mirrors and `/llms.txt`
 * benefit from a predictable site-wide shape.
 *
 *   ---
 *   title: ...
 *   description: ...
 *   slug: ...
 *   locale: ...
 *   publishedAt: ...
 *   ---
 *
 *   # <title>
 *
 *   > <description>
 *
 *   <content>
 *
 * Entries without serializable public content skip the `.md` mirror.
 *
 * Pure transformation — no I/O. Lives in `domain/service/`.
 */
/**
 * `content`/`body` win, then structured sections, then a non-empty
 * description/summary. One predicate keeps mirrors and metadata in sync.
 */
export function getMarkdownBody(entry: Entry): string | null {
  const data = entry.data;
  for (const key of ["content", "body"] as const) {
    const value = nonEmptyString(data[key]);
    if (value) return value;
  }
  const sections = serializeSections(data["sections"]);
  if (sections) return sections;
  return getEntryDescription(entry);
}

export function hasMarkdownBody(entry: Entry): boolean {
  return getMarkdownBody(entry) !== null;
}

export function getEntryDescription(entry: Entry): string | null {
  return nonEmptyString(entry.data["description"])
    ?? nonEmptyString(entry.data["summary"]);
}

export function serializeEntryAsMarkdown(entry: Entry): string | null {
  const data = entry.data;
  const content = getMarkdownBody(entry);
  if (content == null) return null;

  const fm: Array<[string, string]> = [];
  for (const k of ["title", "slug", "locale", "publishedAt"] as const) {
    const v = k === "locale" ? entry.locale : data[k];
    if (typeof v === "string" && v.length > 0) fm.push([k, v]);
  }

  const title = (data["title"] as string | undefined) ?? entry.id;
  const description = getEntryDescription(entry);
  if (description) fm.splice(1, 0, ["description", description]);

  let out = "---\n";
  for (const [k, v] of fm) out += `${k}: ${yamlScalar(v)}\n`;
  out += "---\n\n";
  out += `# ${title}\n\n`;
  if (description) out += `> ${description}\n\n`;
  out += content;
  if (!content.endsWith("\n")) out += "\n";
  return out;
}

/**
 * Per-locale `/llms.txt` index. One section per collection, one bullet
 * per entry. The shape follows the llms.txt convention (Howard, 2024-11)
 * so agent consumers can rely on a stable structure.
 */
export function serializeLlmsTxt(args: {
  readonly site: WebSiteConfig;
  readonly locale: string;
  readonly entriesByCollection: ReadonlyMap<string, readonly Entry[]>;
  readonly pathFor: (entry: Entry) => string | null;
}): string | null {
  const { site, locale, entriesByCollection, pathFor } = args;
  const sections: string[] = [];
  for (const [collection, entries] of entriesByCollection) {
    const bullets: string[] = [];
    for (const e of entries) {
      if (!hasMarkdownBody(e)) continue;
      const data = e.data;
      const title = (data["title"] as string | undefined) ?? e.id;
      const path = pathFor(e);
      if (!path) continue;
      const desc = getEntryDescription(e) ?? "";
      const url = appendMarkdownExt(absoluteUrl(site.origin, path));
      bullets.push(desc ? `- [${title}](${url}): ${desc}` : `- [${title}](${url})`);
    }
    if (bullets.length > 0) sections.push(`## ${collection}\n\n${bullets.join("\n")}`);
  }
  if (sections.length === 0) return null;
  let out = `# ${site.title}\n\n`;
  if (site.description) out += `> ${site.description}\n\n`;
  if (locale) out += `Locale: ${locale}\n\n`;
  return `${out}${sections.join("\n\n")}\n`;
}

function serializeSections(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const sections = value.map(serializeSection).filter((section) => section.length > 0);
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function serializeSection(value: unknown): string {
  if (!isRecord(value)) return "";
  const heading = nonEmptyString(value["title"]);
  const lines = heading ? [`## ${heading}`] : [];
  for (const key of ["eyebrow", "body", "description", "quote", "value"] as const) {
    const text = nonEmptyString(value[key]);
    if (text && text !== heading) lines.push(text);
  }
  if (Array.isArray(value["items"])) {
    for (const item of value["items"]) {
      if (!isRecord(item)) continue;
      const title = nonEmptyString(item["title"]);
      const body = nonEmptyString(item["body"])
        ?? nonEmptyString(item["description"])
        ?? nonEmptyString(item["quote"]);
      if (title && body) lines.push(`- **${title}:** ${body}`);
      else if (title ?? body) lines.push(`- ${title ?? body}`);
    }
  }
  return lines.join("\n\n");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlScalar(s: string): string {
  if (/^[A-Za-z0-9._/-][\w. /:-]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s)) {
    return s;
  }
  return JSON.stringify(s);
}
