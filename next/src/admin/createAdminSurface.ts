/**
 * The Admin surface (ADR-0032 decisions 8 and 9): the staff JSON API under `{basePath}/api` and the SPA shell under `{basePath}`.
 * Every API route needs a staff caller. Reads and runs go through `store.as(caller)` and `invokeProcedure`, so Admin sees what the
 * caller's scope sees and nothing wider. Routes of an `AdminIdentity` facet that is absent do not exist.
 */
import { MCP_HINT_KEYWORD, STAFF_ROLES, isMediaMcpHint, isStaffRole, makeDiagnostic, meetsRole, redactForWire, resolveMantleRef, type JsonSchema, type PlanSchema, type StaffRole } from "../spec/index.js";
import { evaluateAuthAll, type Caller, type CallerStore, type MantleRuntime, type MediaAsset, type MediaStorage, type SiteSettings, type StoreRow, type StoreScalar, type StoreSelect, type StoreSelectResult, type StoreWhere, type Surface } from "../core/index.js";
import { siteConfigOf } from "../core/sql/site.js";
import { coerce, failure, json, match, readJsonObject, viewQuery, wireError } from "../core/wire.js";
import { decodeMemberCursor } from "./consent.js";
import type { AdminIdentity, MemberUserInfo, StaffUserInfo } from "./identity.js";

/** The built SPA: `path` is relative to the base path (`index.html` is the shell). `null` is a missing file. */
export type AdminAssets = (path: string) => Response | null | Promise<Response | null>;

export interface AdminSurfaceOptions {
  /** Where Admin answers, e.g. `/admin`; the API is `{basePath}/api`. */
  readonly basePath: string;
  readonly identity?: AdminIdentity;
  readonly assets?: AdminAssets;
  /** The MCP surfaces the service mounted, as paths or URLs; `/site` resolves them against the public URL. */
  readonly site?: { readonly mcpEndpoints?: { readonly public: string | null; readonly staff: string | null } };
  /** Media objects; the media routes also need `runtime.site`, which owns the tables, and answer 501 without either. */
  readonly media?: MediaStorage;
}

type Staff = Extract<Caller, { kind: "user" }> & { readonly role: StaffRole };
interface Route {
  readonly method: string;
  readonly path: string;
  readonly role: StaffRole;
  /** A Response (a download, a denial) goes out as it is; anything else is the JSON body. */
  run(c: { request: Request; url: URL; caller: Staff; params: Record<string, string> }): Promise<unknown>;
}

const NO_STORE = { "cache-control": "no-store" };
const P = "admin";
const bad = (message: string) => wireError("INPUT_VALIDATION_FAILED", message, P);
type Props = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
const propsOf = (s: JsonSchema) => (s.properties ?? {}) as Props;
/** A role denial names the minimum role, so the SPA can say who may do it. */
const denied = (role: StaffRole, message: string) =>
  json({ error: redactForWire(makeDiagnostic({ code: "AUTH_DENIED", phase: "runtime", severity: "error", path: P, expected: `${role} role or higher`, message })), minimumRole: role }, 403, NO_STORE);

/** What the SPA lists and edits for one Schema; a translation's parent is the entry sharing its `on`. */
function collectionOf(s: PlanSchema, schemas: readonly PlanSchema[]) {
  const names = new Set(schemas.filter((x) => !x.translates).map((x) => x.name));
  const props = propsOf(s.schema);
  const required = new Set(s.schema.required ?? []);
  const ui = (s.uiSchema ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const list = ui["list"] ?? {};
  const nav = ui["nav"];
  const filterField = list["filterField"] as string | undefined;
  // a required reference is composition: the child sits under its parent in the sidebar
  const parentField = Object.keys(props).find((f) => required.has(f) && resolveMantleRef(props[f])?.field === "id" && names.has(resolveMantleRef(props[f])!.schema));
  const navField = nav?.["standalone"] === true ? (nav["parentField"] as string | undefined) ?? parentField : undefined;
  const navParent = navField ? resolveMantleRef(props[navField]) : null;
  const children = schemas.filter((c) => c.translates?.parent === s.name);
  return {
    name: s.name, title: s.title ?? s.name, description: s.description ?? null,
    lifecycle: s.publishing ? "publishing" : "operational",
    parent: s.translates ? { collection: s.translates.parent, parentField: s.translates.on, childField: s.translates.on }
      : parentField ? { collection: resolveMantleRef(props[parentField])!.schema, parentField: "id", childField: parentField } : null,
    hasTranslations: children.length > 0, localized: s.localized === true || !!s.translates, translates: s.translates ?? null,
    schema: s.schema, uiSchema: s.uiSchema ?? null,
    mediaFields: [s, ...children].flatMap((x) => Object.entries(propsOf(x.schema)).flatMap(([name, p]) => (isMediaMcpHint(p[MCP_HINT_KEYWORD]) ? [{ name, hint: p[MCP_HINT_KEYWORD] }] : []))),
    // the plan lower-cases index columns; `names` maps them back to the declared spelling
    sortableFields: [...new Set([...(s.unique ?? []), ...(s.indexes ?? [])].map((i) => s.names[i[0]!] ?? i[0]!).filter((f) => required.has(f)))],
    filter: filterField ? { field: filterField, values: props[filterField]?.["enum"] ?? [] } : null,
    list: { primaryField: (list["primaryField"] as string | undefined) ?? null, columns: (list["columns"] as string[] | undefined) ?? [] },
    nav: navField && navParent ? { standalone: true, parentField: navField, parentCollection: navParent.schema } : null,
  };
}

/** The settings page's fields and their longest value; the old surface had no limit. */
const SETTINGS = { brand: 80, title: 200, description: 1000 } as const;

/** A committed asset with its primary variant lifted, so the library grid renders without deriving it. */
const settingsOf = ({ brand, title, description }: SiteSettings) => ({ brand, title, description });

function mediaItem(a: MediaAsset) {
  const primary = a.variants.find((v) => v.role === "primary") ?? a.variants[0];
  return { id: a.id, variants: a.variants, primaryUrl: primary?.publicUrl ?? null, mime: primary?.mimeType ?? null, byteSize: primary?.byteSize ?? null, alt: a.alt ?? null, caption: a.caption ?? null, createdAt: a.createdAt };
}

/** Store's native columns: `data` never sets them (status moves by publish and unpublish). */
const NATIVE = ["id", "status", "version", "createdAt", "updatedAt", "authorId"];
/** Store keeps microseconds; the Admin wire keeps the old milliseconds. */
const ms = (us: unknown) => (typeof us === "number" ? Math.floor(us / 1000) : null);

/** RFC 4180 quoting, and a text that a spreadsheet would run as a formula gets a leading `'`. */
function csvCell(v: unknown): string {
  const t = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const safe = typeof v === "string" && /^[\s\u0000-\u001f]*[=+@-]|^[\t\r]/u.test(t) ? `'${t}` : t;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Every page as one CSV download. The first page is read before answering, so a bad query is a JSON error, not a broken file. */
async function csv(name: string, read: (cursor?: string) => Promise<StoreSelectResult>, columnsOf: (rows: readonly StoreRow[]) => readonly string[], cell: (row: StoreRow, column: string) => unknown): Promise<Response> {
  let page = await read();
  const columns = columnsOf(page.rows);
  const line = (xs: readonly unknown[]) => `${xs.map(csvCell).join(",")}\r\n`;
  async function* lines() {
    yield `\uFEFF${line(columns)}`;
    for (;;) {
      yield page.rows.map((r) => line(columns.map((c) => cell(r, c)))).join("");
      if (!page.nextCursor) return;
      page = await read(page.nextCursor);
    }
  }
  const it = lines();
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try { const n = await it.next(); if (n.done) c.close(); else c.enqueue(enc.encode(n.value)); } catch (e) {
        // the status line is gone once a page has streamed: end the download as failed, and leave a trace
        console.error("[mantle admin] export failed mid-stream", e);
        c.error(e);
      }
    },
    async cancel() { await it.return(undefined); },
  });
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, ...NO_STORE } });
}

export function createAdminSurface(runtime: MantleRuntime, options: AdminSurfaceOptions): Surface {
  const base = options.basePath.replace(/\/+$/, "");
  const { plan } = runtime;
  const { directory, roles } = options.identity ?? {};
  const schemas = Object.values(plan.schemas);
  const projected = new Map(schemas.map((s) => [s, collectionOf(s, schemas)]));
  const projection = (s: PlanSchema) => projected.get(s)!;
  const collections = schemas.filter((s) => !s.translates).map(projection);
  const staffProcedures = [...new Set(Object.values(plan.triggers).flatMap((t) => (t.source.kind === "mcp" && t.source.surface === "staff" ? [t.procedure] : [])))];
  const sees = (requires: Parameters<typeof evaluateAuthAll>[0], caller: Staff) => evaluateAuthAll(requires, caller, P) === null;
  const operations = (caller: Staff) => staffProcedures.filter((name) => sees(plan.procedures[name]!.requires, caller)).map((name) => {
    const p = plan.procedures[name]!;
    return {
      name, title: p.title ?? null, description: p.description ?? null, input: p.input, uiSchema: p.uiSchema ?? null,
      interactions: p.target ? [{ collection: p.target.schema, bind: [{ input: p.target.id, field: "id" }], ...(p.target.version ? { version: p.target.version } : {}), mutates: true }] : [],
    };
  });
  const staffView = (name: string, caller: Staff) => {
    const v = plan.views[name];
    // a View the caller cannot see is not there for them, so its name and its rule cannot be probed
    if (!v || v.surface !== "staff" || !sees(v.requires, caller)) throw wireError("NOT_FOUND", `no staff View '${name}'`, P);
    return v;
  };
  const views = (caller: Staff) => Object.entries(plan.views).filter(([, v]) => v.surface === "staff" && sees(v.requires, caller)).map(([name, v]) => {
    const list = (v.uiSchema?.["list"] ?? {}) as Record<string, string[] | undefined>;
    return { name, title: v.title ?? null, description: v.description ?? null, input: v.input ?? null, list: { columns: list["columns"] ?? [], searchFields: list["searchFields"] ?? [], filterFields: list["filterFields"] ?? [] } };
  });
  // a custom directory may return more than it declares: only the declared fields reach the wire
  const staffInfo = ({ id, email, name, role, githubLogin, emailVerified, createdAt }: StaffUserInfo) => ({ id, email, name, role, githubLogin, emailVerified, createdAt });
  const memberInfo = ({ id, email, name, emailVerified, createdAt }: MemberUserInfo) => ({ id, email, name, emailVerified, createdAt });
  const site = async (url: URL) => {
    const { origin, ...config } = runtime.site ? await runtime.site.read() : siteConfigOf([]);
    const publicUrl = origin || url.origin;
    const at = (p: string | null | undefined) => (p ? new URL(p, publicUrl).href : null);
    const mcp = options.site?.mcpEndpoints;
    return { ...config, publicUrl, mcpEndpoints: { public: at(mcp?.public), staff: at(mcp?.staff) } };
  };
  const library = options.media && runtime.site?.media(options.media);
  const media = () => {
    if (!library) throw wireError("MEDIA_NOT_CONFIGURED", "Media is not enabled on this deployment: give the storage adapter site defaults and createAdminSurface a MediaStorage.", P);
    return library;
  };
  const me = async (caller: Staff) => {
    const u = await directory?.getUser?.(caller.subject);
    return { userId: caller.subject, role: caller.role, login: u ? u.githubLogin || u.name || u.email || null : null, image: u?.image ?? null };
  };

  // ---- entries: every read and write is the caller's own Store, so a scoped Schema shows the caller's rows only (G2b)
  const schemaOf = (name: unknown) => {
    if (typeof name !== "string" || !name) throw bad("a `collection` naming a Schema is required");
    const s = Object.hasOwn(plan.schemas, name.toLowerCase()) ? plan.schemas[name.toLowerCase()]! : undefined;
    if (!s) throw wireError("NOT_FOUND", `no collection '${name}'`, P);
    return s;
  };
  // root `readOnly: true` keeps generic authoring off a Schema its Procedures maintain
  const writable = (s: PlanSchema) => {
    if (s.schema.readOnly === true) throw wireError("CONFLICT", `Schema '${s.name}' is read-only on generic authoring surfaces; use its declared Procedures.`, P);
  };
  const dataOf = (body: Record<string, unknown>) => {
    const d = body["data"] ?? {};
    if (typeof d !== "object" || d === null || Array.isArray(d)) throw bad("`data` must be an object");
    const native = Object.keys(d).find((k) => NATIVE.includes(k));
    if (native) throw bad(`\`data\` may not set '${native}': status moves by publish and unpublish, and Store owns the rest`);
    return d as Record<string, unknown>;
  };
  const current = async (store: CallerStore, s: PlanSchema, id: string) => {
    const [row] = (await store.select({ from: s.name, where: { id }, limit: 1 })).rows;
    if (!row) throw wireError("NOT_FOUND", `no ${s.name} entry '${id}'`, P);
    return row;
  };
  const entryOf = (s: PlanSchema, row: StoreRow) => {
    const { id, status, version, createdAt: _c, updatedAt, authorId: _a, ...data } = row;
    return { id: String(id), collection: s.name, locale: typeof data["locale"] === "string" ? data["locale"] : null, status: status ?? null, version, data, updated_at: ms(updatedAt) };
  };
  const titleOf = (s: PlanSchema, data: Readonly<Record<string, unknown>>) => {
    const props = propsOf(s.schema);
    const key = [projection(s).list.primaryField, "title", "name", "slug", ...(s.schema.required ?? []).filter((f) => [props[f]?.["type"]].flat().includes("string"))]
      .find((k) => k && typeof data[k] === "string" && data[k] !== "");
    return key ? (data[key] as string) : null;
  };
  const listQuery = (s: PlanSchema, q: URLSearchParams): StoreSelect => {
    if (q.get("cursor_direction") === "backward") throw bad("entries page forward only: keep the cursors already seen to go back");
    const where: StoreWhere[] = [];
    const status = q.get("status");
    if (s.publishing && status && status !== "all") where.push({ status });
    for (const k of ["filter", "scope"]) {
      const field = q.get(`${k}_field`), value = q.get(`${k}_value`);
      if (!field !== !value) throw bad(`${k}_field and ${k}_value go together`);
      if (field) where.push({ [field]: coerce(value!, propsOf(s.schema)[field], field, P) as StoreScalar });
    }
    const search = q.get("search")?.trim();
    // `like` over the declared searchable text fields and the id (Store has no full-text search, G4)
    if (search) where.push({ or: ["id", ...(s.search ?? []).filter((f) => s.fields[f] === "text")].map((f) => ({ [f]: { like: `%${search}%` } })) });
    return { from: s.name, ...(where.length ? { where: { and: where } } : {}), orderBy: { [q.get("sort") || "updatedAt"]: q.get("direction") === "asc" ? "asc" : "desc" } };
  };
  const everyPage = async (store: CallerStore, q: StoreSelect) => {
    const rows: StoreRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.select({ ...q, ...(cursor ? { cursor } : {}) });
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  };
  /** Each row's translation locales: a second select per translation Schema, `in` the page's keys, in chunks under the bind limit. */
  const localesOf = async (store: CallerStore, s: PlanSchema, rows: readonly StoreRow[]) => {
    const out = new Map<string, Set<string>>(rows.map((r) => [String(r["id"]), new Set()]));
    for (const t of schemas.filter((x) => x.translates?.parent === s.name && x.fields["locale"])) {
      const on = t.translates!.on;
      const keys = [...new Set(rows.map((r) => r[on]).filter((v) => v !== null && v !== undefined && v !== ""))] as StoreScalar[];
      const byKey = new Map<unknown, Set<string>>();
      for (let i = 0; i < keys.length; i += 50) {
        for (const tr of await everyPage(store, { from: t.name, columns: [on, "locale"], where: { [on]: { in: keys.slice(i, i + 50) } }, limit: 500 })) {
          if (typeof tr["locale"] === "string") byKey.set(tr[on], (byKey.get(tr[on]) ?? new Set()).add(tr["locale"]));
        }
      }
      for (const r of rows) for (const l of byKey.get(r[on]) ?? []) out.get(String(r["id"]))!.add(l);
    }
    return out;
  };
  const list = async (caller: Staff, q: URLSearchParams) => {
    const s = schemaOf(q.get("collection"));
    const store = runtime.store.as(caller);
    const limit = q.get("limit");
    const cursor = q.get("cursor");
    const page = await store.select({ ...listQuery(s, q), ...(limit ? { limit: coerce(limit, { type: "integer" }, "limit", P) as number } : {}), ...(cursor ? { cursor } : {}) });
    const locales = await localesOf(store, s, page.rows);
    const ui = projection(s).list;
    const preview = [...(ui.primaryField ? [ui.primaryField] : []), ...ui.columns];
    return {
      items: page.rows.map((row) => {
        const e = entryOf(s, row);
        return {
          id: e.id, collection: s.name, locale: e.locale, status: e.status, version: e.version, title: s.publishing ? titleOf(s, e.data) : null, updated_at: e.updated_at,
          translation_locales: [...locales.get(e.id)!],
          ...(!s.publishing && preview.length ? { data_preview: Object.fromEntries(preview.map((f) => [f, row[f] ?? null])) } : {}),
        };
      }),
      // forward only: Store pages one way, so the client keeps the cursors it has seen (G5)
      next_cursor: page.nextCursor ?? null,
    };
  };
  /** The editor's payload: the entry, its parent, and the related sections (translations, and Schemas that reference it by id). */
  const editor = async (store: CallerStore, s: PlanSchema, row: StoreRow) => {
    const join = (v: unknown) => (v === undefined || v === "" ? null : v as StoreScalar);
    const up = projection(s).parent;
    const upValue = up ? join(row[up.childField]) : null;
    const parentSchema = up && upValue !== null ? schemaOf(up.collection) : undefined;
    const [parent] = parentSchema ? (await store.select({ from: parentSchema.name, where: { [up!.parentField]: upValue }, limit: 1 })).rows : [];
    const rels = [
      ...(s.translates ? [{ t: s, kind: "translation", parentField: s.translates.on, childField: s.translates.on }] : []),
      ...schemas.filter((c) => c !== s).flatMap((c) => c.translates?.parent === s.name
        ? [{ t: c, kind: "translation", parentField: c.translates.on, childField: c.translates.on }]
        : Object.entries(propsOf(c.schema)).filter(([, p]) => resolveMantleRef(p)?.schema === s.name && resolveMantleRef(p)!.field === "id").map(([f]) => ({ t: c, kind: "field", parentField: "id", childField: f }))),
    ];
    const related = await Promise.all(rels.map(async ({ t, kind, parentField, childField }) => {
      const parentValue = join(row[parentField]);
      const rows = parentValue === null ? [] : (await store.select({ from: t.name, where: { [childField]: parentValue }, limit: 50 })).rows;
      return { collection: projection(t), relationship: { kind, parentField, childField, parentValue }, entries: rows.map((r) => entryOf(t, r)) };
    }));
    return {
      collection: projection(s), entry: entryOf(s, row),
      parentEntryId: parent ? String(parent["id"]) : null, parentEntryTitle: parent ? titleOf(parentSchema!, entryOf(parentSchema!, parent).data) ?? String(parent["id"]) : null,
      related,
    };
  };
  const move = (status: "published" | "draft"): Route["run"] => async ({ caller, params: { id }, url }) => {
    const s = schemaOf(url.searchParams.get("collection"));
    writable(s);
    const store = runtime.store.as(caller);
    await current(store, s, id!);
    // the lifecycle, a publish's completeness and a translation's parent-first rule are Store's (ADR-0032 decision 1)
    await store.write([{ update: s.name, set: { status }, where: { id: id! } }]);
    return editor(store, s, await current(store, s, id!));
  };

  const routes: Route[] = [
    { method: "GET", path: "/me", role: "contributor", run: ({ caller }) => me(caller) },
    {
      method: "GET", path: "/bootstrap", role: "contributor", run: async ({ caller, url, url: { searchParams: q } }) => ({
        me: await me(caller), site: await site(url), collections, operations: operations(caller), views: views(caller),
        // the first page of the collection the SPA opens on
        ...(q.get("collection") ? { entries: await list(caller, q) } : {}),
      }),
    },
    { method: "GET", path: "/collections", role: "contributor", run: async () => ({ collections }) },
    { method: "GET", path: "/site", role: "contributor", run: ({ url }) => site(url) },
    // the bytes go straight to the bucket: create, PUT each variant to its uploadUrl, commit
    { method: "POST", path: "/media/uploads", role: "editor", run: async ({ request }) => media().createUpload(await readJsonObject(request, P)) },
    { method: "POST", path: "/media/uploads/{groupId}/commit", role: "editor", run: async ({ request, params: { groupId } }) => media().commitUpload(groupId!, await readJsonObject(request, P)) },
    {
      method: "GET", path: "/media", role: "editor", run: async ({ url: { searchParams: q } }) => {
        const limit = q.get("limit");
        // the callee first: an unconfigured library is 501 before the query is read
        const r = await media().list({ ...(limit ? { limit: coerce(limit, { type: "integer" }, "limit", P) as number } : {}), ...(q.get("cursor") ? { cursor: q.get("cursor")! } : {}), ...(q.get("search")?.trim() ? { search: q.get("search")!.trim() } : {}) });
        return { items: r.rows.map(mediaItem), next_cursor: r.nextCursor ?? null };
      },
    },
    { method: "GET", path: "/media/{id}", role: "editor", run: async ({ params: { id } }) => mediaItem(await media().get(id!)) },
    { method: "PATCH", path: "/media/{id}", role: "editor", run: async ({ request, params: { id } }) => mediaItem(await media().update(id!, await readJsonObject(request, P))) },
    { method: "DELETE", path: "/media/{id}", role: "editor", run: async ({ params: { id } }) => media().delete(id!) },
    { method: "GET", path: "/views-manifest", role: "contributor", run: async ({ caller }) => ({ views: views(caller) }) },
    {
      method: "GET", path: "/views/{name}", role: "contributor", run: ({ caller, params: { name }, url }) =>
        runtime.store.as(caller).view(name!, viewQuery(name!, staffView(name!, caller), url.searchParams, P)),
    },
    {
      method: "GET", path: "/views/{name}/export", role: "contributor", run: ({ caller, params: { name }, url }) => {
        const v = staffView(name!, caller);
        const { input } = viewQuery(name!, v, url.searchParams, P);
        const declared = ((v.uiSchema?.["list"] ?? {}) as Record<string, string[] | undefined>)["columns"] ?? [];
        const store = runtime.store.as(caller);
        return csv(name!, (cursor) => store.view(name!, { input, limit: 500, ...(cursor ? { cursor } : {}) }),
          (rows) => (declared.length ? declared : [...new Set(rows.flatMap((r) => Object.keys(r)))]), (row, c) => row[c]);
      },
    },
    { method: "GET", path: "/entries", role: "contributor", run: ({ caller, url }) => list(caller, url.searchParams) },
    // before `/entries/{id}`, which has as many segments
    {
      method: "GET", path: "/entries/export", role: "contributor", run: ({ caller, url: { searchParams: q } }) => {
        const s = schemaOf(q.get("collection"));
        const query = listQuery(s, q);
        const store = runtime.store.as(caller);
        const columns = ["id", ...(s.publishing ? ["status"] : []), "version", "updated_at", ...Object.keys(propsOf(s.schema)).filter((f) => f.toLowerCase() !== s.scope && s.fields[f.toLowerCase()] !== "geo")];
        return csv(s.name, (cursor) => store.select({ ...query, limit: 500, ...(cursor ? { cursor } : {}) }), () => columns, (row, c) => (c === "updated_at" ? ms(row["updatedAt"]) : row[c]));
      },
    },
    {
      method: "GET", path: "/entries/{id}", role: "contributor", run: async ({ caller, params: { id }, url }) => {
        const s = schemaOf(url.searchParams.get("collection"));
        const store = runtime.store.as(caller);
        return editor(store, s, await current(store, s, id!));
      },
    },
    {
      method: "POST", path: "/entries", role: "contributor", run: async ({ caller, request }) => {
        const body = await readJsonObject(request, P);
        const s = schemaOf(body["collection"]);
        writable(s);
        if (caller.role === "contributor" && !s.publishing) return denied("editor", "Contributors can create drafts, not operational records.");
        const store = runtime.store.as(caller);
        const [r] = await store.write([{ insert: s.name, values: dataOf(body) }]);
        return editor(store, s, await current(store, s, (r as { id: string }).id));
      },
    },
    {
      method: "PATCH", path: "/entries/{id}", role: "contributor", run: async ({ caller, params: { id }, request, url }) => {
        const s = schemaOf(url.searchParams.get("collection"));
        writable(s);
        const store = runtime.store.as(caller);
        const row = await current(store, s, id!);
        if (caller.role === "contributor" && (!s.publishing || row["status"] !== "draft")) return denied("editor", "Contributors can edit drafts only.");
        const body = await readJsonObject(request, P);
        const lock = body["expectedVersion"];
        if (typeof lock !== "number" || !Number.isSafeInteger(lock) || lock < 0) throw bad("`expectedVersion` (the version the editor loaded) is required");
        await store.write([{ update: s.name, set: dataOf(body), where: { id: id! }, lock }]);
        return editor(store, s, await current(store, s, id!));
      },
    },
    { method: "POST", path: "/entries/{id}/publish", role: "editor", run: move("published") },
    { method: "POST", path: "/entries/{id}/unpublish", role: "editor", run: move("draft") },
    {
      method: "DELETE", path: "/entries/{id}", role: "editor", run: async ({ caller, params: { id }, url }) => {
        const s = schemaOf(url.searchParams.get("collection"));
        writable(s);
        const store = runtime.store.as(caller);
        await current(store, s, id!);
        return (await store.write([{ delete: s.name, where: { id: id! } }]))[0];
      },
    },
    { method: "GET", path: "/operations", role: "contributor", run: async ({ caller }) => ({ operations: operations(caller) }) },
    {
      method: "POST", path: "/operations/{name}", role: "contributor", run: async ({ caller, params: { name }, request }) => {
        // an operation the caller cannot see is not there for them, so its name cannot be probed
        if (!staffProcedures.includes(name!) || !sees(plan.procedures[name!]!.requires, caller)) throw wireError("NOT_FOUND", `no staff operation '${name}'`, P);
        const input = await readJsonObject(request, P);
        return { ok: true, output: await runtime.invokeProcedure({ procedure: name!, input, caller, cause: { kind: "http", id: crypto.randomUUID() } }) };
      },
    },
  ];
  const siteStore = runtime.site;
  if (siteStore) routes.push(
    { method: "GET", path: "/site-settings", role: "owner", run: async () => settingsOf(await siteStore.read()) },
    {
      method: "PATCH", path: "/site-settings", role: "owner", run: async ({ request }) => {
        const body = await readJsonObject(request, P);
        const values: Record<string, string> = {};
        for (const [k, max] of Object.entries(SETTINGS)) {
          const v = body[k];
          if (v === undefined) continue;
          if (typeof v !== "string" || v.length > max) throw bad(`'${k}' must be a string of at most ${max} characters`);
          values[k] = v;
        }
        return settingsOf(await siteStore.updateSettings(values as SiteSettings));
      },
    },
  );
  if (directory) routes.push(
    { method: "GET", path: "/staff", role: "owner", run: async () => ({ users: (await directory.listUsers()).map(staffInfo) }) },
    {
      method: "GET", path: "/members", role: "editor", run: async ({ url: { searchParams: q } }) => {
        const limit = Number(q.get("limit") ?? 50);
        const cursor = q.get("cursor") || undefined;
        const search = q.get("search")?.trim() || undefined;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !decodeMemberCursor(cursor)) || (search?.length ?? 0) > 200) throw bad("limit must be 1..100, the cursor one this list returned, and search at most 200 characters");
        const r = await directory.listMembers({ limit, ...(search ? { search } : {}), ...(cursor ? { cursor } : {}), cursorDirection: q.get("cursor_direction") === "backward" ? "backward" : "forward" });
        return { items: r.items.map(memberInfo), previous_cursor: r.previousCursor, next_cursor: r.nextCursor };
      },
    },
  );
  if (roles) routes.push(
    {
      method: "PATCH", path: "/staff/{id}/role", role: "owner", run: async ({ caller, params: { id }, request }) => {
        const { role } = await readJsonObject(request, P);
        if (role !== null && !(typeof role === "string" && isStaffRole(role))) throw bad(`role must be one of ${STAFF_ROLES.join(", ")}, or null to revoke`);
        // demoting the only owner would lock everyone out of staff management
        if (id === caller.subject) throw wireError("AUTH_DENIED", "You cannot change your own role.", P);
        if (!await roles.setUserRole(id!, role)) throw wireError("NOT_FOUND", "no user with that id", P);
        return { ok: true };
      },
    },
    {
      method: "POST", path: "/staff/invitations", role: "owner", run: async ({ caller, request }) => {
        const body = await readJsonObject(request, P);
        const email = typeof body["email"] === "string" ? body["email"].trim().toLowerCase() : "";
        const role = body["role"];
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !(typeof role === "string" && isStaffRole(role))) throw bad(`an invitation needs an email and a role in ${STAFF_ROLES.join(", ")}`);
        const r = await roles.inviteUser(email, role);
        if (r.kind === "exists") {
          if (r.id === caller.subject) throw wireError("AUTH_DENIED", "You cannot change your own role.", P);
          await roles.setUserRole(r.id, role);
        }
        await roles.sendStaffInvitation?.(email, role);
        return { ok: true, userId: r.id, emailSent: roles.sendStaffInvitation !== undefined };
      },
    },
    {
      method: "DELETE", path: "/staff/invitations/{id}", role: "owner", run: async ({ params: { id } }) => {
        if (!await roles.revokeInvite(id!)) throw wireError("CONFLICT", "Only an invitation nobody has signed in to can be revoked; clear an active user's role instead.", P);
        return { ok: true };
      },
    },
  );

  const api = async (request: Request, url: URL, caller: Caller): Promise<Response> => {
    if (caller.kind === "anonymous") throw wireError("UNAUTHENTICATED", "Sign in to use Admin.", P);
    if (caller.kind !== "user" || caller.role === null) throw wireError("AUTH_DENIED", "This account is not on the staff list.", P);
    // Admin acts as the person: a token or key minted for something narrower (an MCP client, a script) is not a sign-in
    if (caller.credential !== "session") throw wireError("AUTH_DENIED", "Admin needs a signed-in session.", P);
    const staff = caller as Staff;
    for (const route of routes) {
      const params = route.method === request.method ? match(`${base}/api${route.path}`, url.pathname) : null;
      if (!params) continue;
      if (!meetsRole(staff.role, route.role)) return denied(route.role, `This needs the ${route.role} role.`);
      const out = await route.run({ request, url, caller: staff, params });
      return out instanceof Response ? out : json(out, 200, NO_STORE);
    }
    throw wireError("NOT_FOUND", "no such route", P);
  };

  const shell = async (request: Request, rel: string): Promise<Response> => {
    // the path reaches `assets` as the client sent it, so a traversal or an encoded separator stops here
    if (request.method !== "GET" || !options.assets || /(^|\/)\.\.(\/|$)|%2f|%5c|\\/i.test(rel)) throw wireError("NOT_FOUND", "no such route", P);
    const file = rel.split("/").pop()!.includes(".") ? await options.assets(rel) : null;
    // an unknown path is a client-side route (`/members/a.b@x.test` too), which the shell answers
    const res = file ?? (rel.startsWith("assets/") ? null : await options.assets("index.html"));
    if (!res) throw wireError("NOT_FOUND", "no such route", P);
    if (file && rel !== "index.html") return res;
    const headers = new Headers(res.headers);
    // appended, so a policy the asset already carries stays in force
    headers.append("content-security-policy", "frame-ancestors 'none'");
    headers.set("x-frame-options", "DENY");
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  };

  return async (request, caller) => {
    const url = new URL(request.url);
    const rel = url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length + 1) : url.pathname === base ? "" : null;
    const isApi = rel !== null && (rel === "api" || rel.startsWith("api/"));
    try {
      if (rel === null) throw wireError("NOT_FOUND", "no such route", P);
      return isApi ? await api(request, url, caller) : await shell(request, rel);
    } catch (e) {
      return failure(e, P, isApi ? NO_STORE : undefined);
    }
  };
}
