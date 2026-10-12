/** Pure extension review metadata; separate from request dispatch and generation/compiler code. */
import { ADMIN_EXTENSION_TARGETS, type AdminExtension, type AdminExtensionSchema } from "./extension-types.js";
type Declaration = Pick<AdminExtension,"id"|"title"|"module"|"integrity"|"contributes">;
const KINDS = ["pages","settings","actions","panels","fields"] as const;
const MODULE = /^\/(?![/\\])[^\s?#]*$/;
export interface AdminExtensionChange {
  readonly change: "added" | "removed" | "changed";
  /** `<extension>` or `<extension>/<contribution>` */
  readonly ref: string;
  /** For `changed`: the keys that differ, e.g. `role`, `target`, `module`. */
  readonly keys?: readonly string[];
}

const declaration = (e: Declaration) => ({ id: e.id, title: e.title, module: e.module, integrity: e.integrity });

/** What changed between two sets of declarations, for review screens. Handlers are code and are not compared. */
export function diffAdminExtensions(previous: readonly Declaration[], next: readonly Declaration[]): readonly AdminExtensionChange[] {
  const out: AdminExtensionChange[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k])).sort();
  const contributions = (e: Declaration) => new Map(KINDS.flatMap((k) => ((e.contributes[k] ?? []) as readonly { readonly id: string }[]).map((c) => [c.id, { kind: k, ...c }] as const)));
  for (const p of previous) if (!next.some((n) => n.id === p.id)) out.push({ change: "removed", ref: p.id });
  for (const n of next) {
    const p = previous.find((x) => x.id === n.id);
    if (!p) {
      out.push({ change: "added", ref: n.id });
      for (const id of contributions(n).keys()) out.push({ change: "added", ref: `${n.id}/${id}` });
      continue;
    }
    const keys = changedKeys(declaration(p), declaration(n));
    if (keys.length) out.push({ change: "changed", ref: n.id, keys });
    const before = contributions(p);
    const after = contributions(n);
    for (const [id] of before) if (!after.has(id)) out.push({ change: "removed", ref: `${n.id}/${id}` });
    for (const [id, c] of after) {
      const b = before.get(id);
      if (!b) out.push({ change: "added", ref: `${n.id}/${id}` });
      else {
        const k = changedKeys(b, c);
        if (k.length) out.push({ change: "changed", ref: `${n.id}/${id}`, keys: k });
      }
    }
  }
  return out;
}

const text = { anyOf: [{ type: "string", minLength: 1 }, { type: "object", additionalProperties: { type: "string", minLength: 1 }, minProperties: 1 }] };
const id = { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" };
const role = { enum: ["staff"] };
const names = { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 64 };
const when = { type: "object", additionalProperties: false, minProperties: 1, properties: { schema: names, field: names, format: names } };
const form = { type: "object", description: "The form subset: an object schema whose properties are string, number, integer or boolean with title, description, default, enum, oneOf, minimum, maximum, minLength and maxLength." };
const contribution = <T extends Record<string, unknown>>(props: T, required: readonly string[]) => ({ type: "object", additionalProperties: false, required: ["id", ...required], properties: { id, ...props } });

/** JSON Schema of one extension's declaration (handlers excluded), for tooling and agents. */
export const ADMIN_EXTENSION_JSON_SCHEMA: AdminExtensionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Mantle Admin extension declaration",
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "id", "title", "contributes"],
  properties: {
    apiVersion: { const: 1 },
    id,
    title: text,
    module: { type: "string", pattern: MODULE.source },
    integrity: { type: "string", pattern: "^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$" },
    // the module's code as a string; a function returning it is code, like the handlers, and is not described here
    source: { type: "string", minLength: 1 },
    contributes: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        pages: { type: "array", items: contribution({ title: text, role, nav: { type: "object", additionalProperties: false, required: ["group"], properties: { group: { enum: ["more", "settings"] }, order: { type: "integer" } } } }, ["title", "role"]) },
        settings: { type: "array", items: contribution({ title: text, role, schema: form }, ["title", "role", "schema"]) },
        actions: { type: "array", items: contribution({ title: text, role, target: { enum: ADMIN_EXTENSION_TARGETS.action }, presentation: { enum: ["run", "confirm", "dialog"] }, destructive: { type: "boolean" }, when }, ["title", "role", "target", "presentation"]) },
        panels: { type: "array", items: contribution({ title: text, role, target: { enum: ADMIN_EXTENSION_TARGETS.panel }, when }, ["title", "role", "target"]) },
        fields: { type: "array", items: contribution({ target: { enum: ADMIN_EXTENSION_TARGETS.field }, role, when, optionsSchema: form }, ["target"]) },
      },
    },
  },
};
