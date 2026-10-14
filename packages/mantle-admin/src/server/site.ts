/** Site, media and identity routes inside Admin's shared session/origin gate. */
import { json, type Context, type Options, type Route, type IdentityMethods } from "./index.js";
import { ContractError } from "@aotter/mantle/contracts";
import { invalid } from "@aotter/mantle/surface";
import { mediaError, mediaItem } from "@aotter/mantle/media";
const settings = ({ brand, title, description }: {
    brand: string;
    title: string;
    description: string;
}) => ({ brand, title, description });
const adminInfo = ({ id, email, name, role, githubLogin, emailVerified, createdAt }: Awaited<ReturnType<IdentityMethods["listUsers"]>>[number]) => ({ id, email, name, role, githubLogin, emailVerified, createdAt });
const memberInfo = ({ id, email, name, emailVerified, createdAt }: Awaited<ReturnType<IdentityMethods["listMembers"]>>["items"][number]) => ({ id, email, name, emailVerified, createdAt });
export function siteRoutes<Env, Database>(options: Options<Env, Database>): Route<Env, Database>[] {
    const site = ({ db, caller }: Context<Env, Database>) => {
        if (!options.site)
            throw mediaError("SITE_NOT_CONFIGURED", "Site settings are not configured.", "admin");
        return options.site(db, caller);
    };
    const media = (context: Context<Env, Database>) => {
        if (!options.site || !options.media)
            throw mediaError("MEDIA_NOT_CONFIGURED", "Media is not configured.", "admin");
        return site(context).media(options.media);
    };
    const identity = async <K extends keyof IdentityMethods>(context: Context<Env, Database>, key: K): Promise<IdentityMethods[K]> => {
        if ((await import("@aotter/mantle/host-caller")).isHostCaller(context.caller)) throw new ContractError("AUTH_DENIED", "Host callers cannot manage members.", "admin");
        const directory = await options.identity?.directory?.(context), method = directory?.[key];
        if (!method)
            throw new ContractError("IDENTITY_NOT_CONFIGURED", "This identity operation is not configured.", "admin", { status: 501 });
        return method.bind(directory) as IdentityMethods[K];
    };
    const other = (context: Context<Env, Database>) => {
        if (context.params.id === context.caller.subject)
            throw new ContractError("AUTH_DENIED", "You cannot change your own admin identity.", "admin");
        return context.params.id!;
    };
    return [
        { method: "GET", path: "/site-settings", run: async (c) => settings(await site(c).read()) },
        { method: "PATCH", path: "/site-settings", run: async (c) => { const s = site(c); return settings(await s.updateSettings(await json(c))); } },
        { method: "POST", path: "/media/uploads", run: async (c) => { const m = media(c); return m.createUpload(await json(c)); } },
        { method: "POST", path: "/media/uploads/{groupId}/commit", run: async (c) => { const m = media(c); return m.commitUpload(c.params.groupId!, await json(c)); } },
        { method: "GET", path: "/media", run: async (c) => {
                const m = media(c), q = c.url.searchParams, raw = q.get("limit"), search = q.get("search")?.trim();
                if (search?.includes("\0"))
                    invalid("Search must not contain NUL.", "admin");
                const result = await m.list({ ...(raw ? { limit: Number(raw) } : {}), ...(q.get("cursor") ? { cursor: q.get("cursor")! } : {}), ...(search ? { search } : {}) });
                return { items: result.rows.map(mediaItem), next_cursor: result.nextCursor ?? null };
            } },
        { method: "GET", path: "/media/{id}", run: async (c) => mediaItem(await media(c).get(c.params.id!)) },
        { method: "PATCH", path: "/media/{id}", run: async (c) => { const m = media(c); return mediaItem(await m.update(c.params.id!, await json(c))); } },
        { method: "DELETE", path: "/media/{id}", run: c => media(c).delete(c.params.id!) },
        { method: "GET", path: "/admin", run: async (c) => ({ users: (await (await identity(c, "listUsers"))()).map(adminInfo) }) },
        { method: "GET", path: "/members", run: async (c) => {
                const list = await identity(c, "listMembers"), q = c.url.searchParams, limit = Number(q.get("limit") ?? 50), search = q.get("search")?.trim() ?? "", cursor = q.get("cursor") || undefined, direction = q.get("cursor_direction") ?? "forward";
                if (!Number.isInteger(limit) || limit < 1 || limit > 100 || search.length > 200 || search.includes("\0") || !["forward", "backward"].includes(direction))
                    invalid("Invalid member page options.", "admin");
                const result = await list({ limit, search, cursor, cursorDirection: direction as "forward" | "backward" });
                return { items: result.items.map(memberInfo), previous_cursor: result.previousCursor, next_cursor: result.nextCursor };
            } },
        { method: "PATCH", path: "/admin/{id}/role", run: async (c) => {
                const id = other(c), set = await identity(c, "setUserRole"), { role } = await json(c);
                if (role !== null && (typeof role !== "string" || !/^[a-z][a-zA-Z0-9_]{0,62}$/.test(role)))
                    invalid("Role must be a role name or null.", "admin");
                if (!await set(id, role as string | null))
                    throw new ContractError("NOT_FOUND", "No such user.", "admin");
                return { ok: true };
            } },
        { method: "POST", path: "/admin/invitations", run: async (c) => {
                const invite = await identity(c, "inviteUser"), input = await json(c), email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof input.role !== "string" || !/^[a-z][a-zA-Z0-9_]{0,62}$/.test(input.role))
                    invalid("An invitation needs an email and the admin role.", "admin");
                const result = await invite(email, input.role as string);
                if (result.id === c.caller.subject)
                    throw new ContractError("AUTH_DENIED", "You cannot change your own admin identity.", "admin");
                const send = options.identity?.roles?.sendAdminInvitation;
                await send?.(email, input.role as string);
                return { ok: true, userId: result.id, emailSent: !!send };
            } },
        { method: "DELETE", path: "/admin/invitations/{id}", run: async (c) => {
                const id = other(c), revoke = await identity(c, "revokeInvite");
                if (!await revoke(id))
                    throw new ContractError("CONFLICT", "Only an invitation nobody has signed in to can be revoked.", "admin");
                return { ok: true };
            } },
    ];
}
