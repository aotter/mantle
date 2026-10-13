/** Selected extension routes over generated declarations and form checks, never a runtime plan. */
import { ContractError } from "@aotter/mantle/contracts";
import { json, type Route } from "./index.js";
import type { AdminExtension } from "./extension-types.js";
export { ADMIN_EXTENSION_TARGETS } from "./extension-types.js";
export type * from "./extension-types.js";
export type ExtensionMetadata = {
    readonly id: string;
    readonly declaration: string;
    readonly public: Readonly<Record<string, unknown>>;
    readonly module?: string;
    readonly integrity?: string;
    readonly source: boolean;
    readonly settings: readonly string[];
    readonly actions: readonly {
        id: string;
        target: string;
        schema?: readonly string[];
    }[];
};
type FormCheck = (value: unknown) => Readonly<Record<string, string>>;
function invalid(message: string, path = "admin-extensions"): never { throw new ContractError("UI_EXTENSION_INVALID", message, path, { status: 400 }); }
function notFound(): never { throw new ContractError("NOT_FOUND", "no such route", "admin"); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function record(raw: unknown) {
    if (!object(raw) || typeof raw.schema !== "string" || typeof raw.id !== "string" || !raw.id || raw.version !== undefined && !Number.isSafeInteger(raw.version))
        throw new ContractError("INPUT_VALIDATION_FAILED", "record is { schema, id, version? }", "admin");
    return { schema: raw.schema, id: raw.id, ...raw.version === undefined ? {} : { version: raw.version as number } };
}
/** Pass returned facets to the Admin server; its session/origin gate owns every API call. */
export function extensionOptions<Env, Database>(metadata: readonly ExtensionMetadata[], checks: Readonly<Record<string, FormCheck>>, definitions: readonly AdminExtension<Env, Database>[]) {
    if (!Array.isArray(definitions) || definitions.length !== metadata.length)
        invalid("Extensions differ from the generated declarations.");
    const bound = metadata.map(meta => {
        const matches = definitions.filter(e => e.id === meta.id);
        if (matches.length !== 1)
            invalid("Extension '" + meta.id + "' is missing or duplicated.");
        const ext = matches[0]!;
        const { handlers, source, bodyLimit, ...declaration } = ext;
        if (JSON.stringify(declaration) !== meta.declaration || (source !== undefined) !== meta.source)
            invalid("Extension '" + meta.id + "' differs from generation.");
        if (bodyLimit !== undefined && (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1))
            invalid("bodyLimit must be a positive integer.");
        if (source !== undefined) invalid("Native Admin does not serve source modules; use a host-served module and shell import-map integrity.");
        if (!object(handlers ?? {}) || Object.keys(handlers ?? {}).some(key => !["api", "settings", "actions"].includes(key)))
            invalid("Handlers have api, settings and actions only.");
        if (handlers?.settings !== undefined && !object(handlers.settings) || handlers?.actions !== undefined && !object(handlers.actions))
            invalid("Handler settings and actions are objects.");
        for (const key of Object.keys(handlers?.settings ?? {}))
            if (!meta.settings.includes(key))
                invalid("Unknown settings handler '" + key + "'.");
        for (const key of Object.keys(handlers?.actions ?? {}))
            if (!meta.actions.some(action => action.id === key))
                invalid("Unknown action handler '" + key + "'.");
        for (const id of meta.settings)
            if (!Object.hasOwn(handlers?.settings ?? {}, id) || typeof handlers?.settings?.[id]?.load !== "function" || typeof handlers.settings[id]!.save !== "function")
                invalid("Settings '" + meta.id + "/" + id + "' needs load and save.");
        for (const action of meta.actions)
            if (!Object.hasOwn(handlers?.actions ?? {}, action.id) || typeof handlers?.actions?.[action.id]?.run !== "function")
                invalid("Action '" + meta.id + "/" + action.id + "' needs run.");
        if (handlers?.api !== undefined && typeof handlers.api !== "function")
            invalid("Extension api must be a function.");
        return { meta, ext };
    });
    const routes: Route<Env, Database>[] = [];
    for (const { meta, ext } of bound) {
        for (const id of meta.settings) {
            const path = "/x/" + meta.id + "/settings/" + id;
            routes.push({ method: "GET", path, run: async (ctx) => ({ value: (await ext.handlers!.settings![id]!.load(ctx.caller, ctx)) ?? null }) }, { method: "PATCH", path, run: async (ctx) => {
                    const value = (await json(ctx)).value, errors = checks[meta.id + "/" + id]!(value);
                    if (Object.keys(errors).length)
                        return Response.json({ error: { code: "INPUT_VALIDATION_FAILED", message: "The settings do not match their schema.", fields: errors } }, { status: 400 });
                    const saved = await ext.handlers!.settings![id]!.save(ctx.caller, value as Record<string, unknown>, ctx);
                    return { value: saved ?? value };
                } });
        }
        for (const action of meta.actions)
            routes.push({ method: "POST", path: "/x/" + meta.id + "/actions/" + action.id, run: async (ctx) => {
                    const raw = await json(ctx);
                    let input: {
                        record?: ReturnType<typeof record>;
                        selection?: {
                            schema: string;
                            ids: string[];
                        };
                        schema?: string;
                    };
                    if (action.target === "record/v1")
                        input = { record: record(raw.record) };
                    else if (action.target === "list.selection/v1") {
                        const s = raw.selection;
                        if (!object(s) || typeof s.schema !== "string" || !Array.isArray(s.ids) || !s.ids.length || s.ids.length > 1000 || s.ids.some(id => typeof id !== "string" || !id))
                            throw new ContractError("INPUT_VALIDATION_FAILED", "selection is { schema, ids } with 1 to 1000 ids", "admin");
                        input = { selection: { schema: s.schema, ids: s.ids as string[] } };
                    }
                    else {
                        if (typeof raw.schema !== "string")
                            throw new ContractError("INPUT_VALIDATION_FAILED", "schema names the list", "admin");
                        input = { schema: raw.schema };
                    }
                    const schema = input.record?.schema ?? input.selection?.schema ?? input.schema!;
                    if (action.schema && !action.schema.includes(schema))
                        notFound();
                    return { ok: true, result: (await ext.handlers!.actions![action.id]!.run(ctx.caller, input, ctx)) ?? null };
                } });
        if (ext.handlers?.api)
            for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
                routes.push({ method, path: "/x/" + meta.id + "/api/{path*}", bodyLimit: ext.bodyLimit, rawBody: true, preserveCacheControl: true, run: async (ctx) => /* a spread would call the lazy db getter */ (await ext.handlers!.api!(ctx.request, Object.assign(Object.create(ctx), { extension: meta.id, path: ctx.params.path ?? "" }))) ?? notFound() });
    }
    return { extensions: metadata.map(meta => meta.public), routes };
}
