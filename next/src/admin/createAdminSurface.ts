/**
 * The Admin surface (ADR-0032 decisions 8 and 9): the staff JSON API under `{basePath}/api` and the SPA shell under `{basePath}`.
 * Every API route needs a staff caller. Reads and runs go through `store.as(caller)` and `invokeProcedure`, so Admin sees what the
 * caller's scope sees and nothing wider. Routes of an `AdminIdentity` facet that is absent do not exist.
 */
import { MCP_HINT_KEYWORD, STAFF_ROLES, isMediaMcpHint, isStaffRole, makeDiagnostic, meetsRole, redactForWire, resolveMantleRef, type JsonSchema, type PlanSchema, type StaffRole } from "../spec/index.js";
import { evaluateAuthAll, type Caller, type MantleRuntime, type Surface } from "../core/index.js";
import { failure, json, match, readJsonObject, viewQuery, wireError } from "../core/wire.js";
import { decodeMemberCursor } from "./consent.js";
import type { AdminIdentity, MemberUserInfo, StaffUserInfo } from "./identity.js";

/** The built SPA: `path` is relative to the base path (`index.html` is the shell). `null` is a missing file. */
export type AdminAssets = (path: string) => Response | null | Promise<Response | null>;

export interface AdminSurfaceOptions {
  /** Where Admin answers, e.g. `/admin`; the API is `{basePath}/api`. */
  readonly basePath: string;
  readonly identity?: AdminIdentity;
  readonly assets?: AdminAssets;
}

type Staff = Extract<Caller, { kind: "user" }> & { readonly role: StaffRole };
interface Route {
  readonly method: string;
  readonly path: string;
  readonly role: StaffRole;
  run(c: { request: Request; url: URL; caller: Staff; params: Record<string, string> }): Promise<unknown>;
}

const NO_STORE = { "cache-control": "no-store" };
const P = "admin";
const bad = (message: string) => wireError("INPUT_VALIDATION_FAILED", message, P);
type Props = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
const propsOf = (s: JsonSchema) => (s.properties ?? {}) as Props;

/** What the SPA lists and edits for one Schema; translation Schemas ride on their parent. */
function collectionsOf(schemas: readonly PlanSchema[]) {
  const names = new Set(schemas.filter((s) => !s.translates).map((s) => s.name));
  return schemas.filter((s) => !s.translates).map((s) => {
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
      parent: parentField ? { collection: resolveMantleRef(props[parentField])!.schema, parentField: "id", childField: parentField } : null,
      hasTranslations: children.length > 0, localized: s.localized === true, translates: s.translates ?? null,
      schema: s.schema, uiSchema: s.uiSchema ?? null,
      mediaFields: [s, ...children].flatMap((x) => Object.entries(propsOf(x.schema)).flatMap(([name, p]) => (isMediaMcpHint(p[MCP_HINT_KEYWORD]) ? [{ name, hint: p[MCP_HINT_KEYWORD] }] : []))),
      // the plan lower-cases index columns; `names` maps them back to the declared spelling
      sortableFields: [...new Set([...(s.unique ?? []), ...(s.indexes ?? [])].map((i) => s.names[i[0]!] ?? i[0]!).filter((f) => required.has(f)))],
      filter: filterField ? { field: filterField, values: props[filterField]?.["enum"] ?? [] } : null,
      list: { primaryField: (list["primaryField"] as string | undefined) ?? null, columns: (list["columns"] as string[] | undefined) ?? [] },
      nav: navField && navParent ? { standalone: true, parentField: navField, parentCollection: navParent.schema } : null,
    };
  });
}

export function createAdminSurface(runtime: MantleRuntime, options: AdminSurfaceOptions): Surface {
  const base = options.basePath.replace(/\/+$/, "");
  const { plan } = runtime;
  const { directory, roles } = options.identity ?? {};
  const collections = collectionsOf(Object.values(plan.schemas));
  const staffProcedures = [...new Set(Object.values(plan.triggers).flatMap((t) => (t.source.kind === "mcp" && t.source.surface === "staff" ? [t.procedure] : [])))];
  const sees = (requires: Parameters<typeof evaluateAuthAll>[0], caller: Staff) => evaluateAuthAll(requires, caller, P) === null;
  const operations = (caller: Staff) => staffProcedures.filter((name) => sees(plan.procedures[name]!.requires, caller)).map((name) => {
    const p = plan.procedures[name]!;
    return {
      name, title: p.title ?? null, description: p.description ?? null, input: p.input, uiSchema: p.uiSchema ?? null,
      interactions: p.target ? [{ collection: p.target.schema, bind: [{ input: p.target.id, field: "id" }], ...(p.target.version ? { version: p.target.version } : {}), mutates: true }] : [],
    };
  });
  const views = (caller: Staff) => Object.entries(plan.views).filter(([, v]) => v.surface === "staff" && sees(v.requires, caller)).map(([name, v]) => {
    const list = (v.uiSchema?.["list"] ?? {}) as Record<string, string[] | undefined>;
    return { name, title: v.title ?? null, description: v.description ?? null, input: v.input ?? null, list: { columns: list["columns"] ?? [], searchFields: list["searchFields"] ?? [], filterFields: list["filterFields"] ?? [] } };
  });
  // a custom directory may return more than it declares: only the declared fields reach the wire
  const staffInfo = ({ id, email, name, role, githubLogin, emailVerified, createdAt }: StaffUserInfo) => ({ id, email, name, role, githubLogin, emailVerified, createdAt });
  const memberInfo = ({ id, email, name, emailVerified, createdAt }: MemberUserInfo) => ({ id, email, name, emailVerified, createdAt });
  const me = async (caller: Staff) => {
    const u = await directory?.getUser?.(caller.subject);
    return { userId: caller.subject, role: caller.role, login: u ? u.githubLogin || u.name || u.email || null : null, image: u?.image ?? null };
  };

  const routes: Route[] = [
    { method: "GET", path: "/me", role: "contributor", run: ({ caller }) => me(caller) },
    { method: "GET", path: "/bootstrap", role: "contributor", run: async ({ caller }) => ({ me: await me(caller), collections, operations: operations(caller), views: views(caller) }) },
    { method: "GET", path: "/collections", role: "contributor", run: async () => ({ collections }) },
    { method: "GET", path: "/views-manifest", role: "contributor", run: async ({ caller }) => ({ views: views(caller) }) },
    {
      method: "GET", path: "/views/{name}", role: "contributor", run: ({ caller, params: { name }, url }) => {
        const v = plan.views[name!];
        // a View the caller cannot see is not there for them, so its name and its rule cannot be probed
        if (!v || v.surface !== "staff" || !sees(v.requires, caller as Staff)) throw wireError("NOT_FOUND", `no staff View '${name}'`, P);
        return runtime.store.as(caller).view(name!, viewQuery(name!, v, url.searchParams, P));
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
      if (!meetsRole(staff.role, route.role)) {
        const d = makeDiagnostic({ code: "AUTH_DENIED", phase: "runtime", severity: "error", path: P, expected: `${route.role} role or higher`, message: `This needs the ${route.role} role.` });
        return json({ error: redactForWire(d), minimumRole: route.role }, 403, NO_STORE);
      }
      return json(await route.run({ request, url, caller: staff, params }), 200, NO_STORE);
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
