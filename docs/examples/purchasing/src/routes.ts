import { ContractError, type Caller } from "@aotter/mantle/contracts";
import { store } from "../generated/generated.js";
import confirmOrder from "../generated/procedures/confirm-order.js";
import { handlers } from "./handlers.js";
import { signInPage, signInRedirect } from "./sign-in.js";

const MAX_BODY = 64 * 1024, MAX_SKEW_SECONDS = 300;
// The employees' app: everything under /app. The pages it has (src/client/app.tsx routes the same three in the browser):
// /app (my requests), /app/new (the form), /app/requests/{id} (one request). AGENT: add a page here and in the app together.
const APP = /^\/app(?:\/.*)?$/, APP_PAGES = /^\/app(?:\/|\/new|\/requests\/[\w-]+)?$/;
const NO_STORE = { "cache-control": "no-store" };

/**
 * App-owned routes, tried before Admin, MCP and REST. Return undefined to fall through.
 * GET /sign-in: member sign-in (src/sign-in.ts). GET /app/...: the employees' single-page app (appShell below).
 * POST /callbacks/supplier: the supplier confirms an order. The signature is checked over the RAW body before parsing.
 * AGENT: match the real supplier's signature scheme (header names, what is signed, encoding).
 */
export async function appRoutes(request: Request, env: Env, context: { caller: () => Promise<Caller>; waitUntil: (task: Promise<unknown>) => void }): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/sign-in" && request.method === "GET") return signInPage();
  if (APP.test(path)) return appShell(request, env, path, context.caller);
  if (path !== "/callbacks/supplier") return undefined;
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (Number(request.headers.get("content-length") ?? MAX_BODY + 1) > MAX_BODY) return new Response(null, { status: 413 });
  const raw = await request.arrayBuffer();
  const timestamp = request.headers.get("x-supplier-timestamp") ?? "";
  if (!(await verified(env.SUPPLIER_WEBHOOK_SECRET, timestamp, raw, request.headers.get("x-supplier-signature") ?? "")))
    return new Response(null, { status: 401 });

  let body: { reference?: unknown; orderId?: unknown };
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response(null, { status: 400 }); }
  if (typeof body.reference !== "string" || typeof body.orderId !== "string") return new Response(null, { status: 400 });
  // Trusted path: a system caller, after the signature proved the sender.
  const system: Caller = { kind: "system", reason: "supplier callback" };
  try {
    await confirmOrder(env.DB, system, { id: body.reference, supplierOrderId: body.orderId });
  } catch (error) {
    if (!(error instanceof ContractError && error.code === "CONFLICT")) throw error;
    // A replay of a callback already applied succeeds again, so the supplier stops retrying.
    const current = await store(env.DB, system, { handlers }).collection("requests").findById(body.reference);
    if (current?.requeststatus === "confirmed" && current.supplierorderid === body.orderId) return new Response(null, { status: 204 });
    return new Response(null, { status: 409 }); // unknown request, another order id, or not approved/ordered
  }
  return new Response(null, { status: 204 });
}

/**
 * The document of every page under /app: public/app/index.html from ASSETS, the same bytes for everyone. It holds no
 * workflow data and no authority; the app reads and writes through /api, where the server checks the session cookie on
 * every call. Anonymous visitors go to /sign-in and come back. `noindex` is in the document and in X-Robots-Tag; robots.txt
 * must not disallow /app, or a crawler never reads it.
 * Cache-Control is no-store although the bytes are the same for everyone: the answer depends on the caller (the shell
 * or a redirect to sign in) and a shared cache keys on the URL, not the cookie, so a stored copy would send one caller
 * the other's answer. Not caching costs one asset read per full page load; moving inside the app fetches no document.
 * A path under /app that the app does not have gets the same document with status 404: the app shows its not-found
 * page, and the URL is a real 404, not a soft one.
 */
async function appShell(request: Request, env: Env, path: string, caller: () => Promise<Caller>) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD", ...NO_STORE } });
  if ((await caller()).kind === "anonymous") return signInRedirect(request);
  // ASSETS serves public/ files by their path; the Worker runs first for /app/*, so this route is the only way to it.
  const shell = await env.ASSETS.fetch(new Request(new URL("/app/index.html", request.url)));
  if (!shell.ok) throw new Error(`public/app/index.html: ASSETS answered ${shell.status}`);
  return new Response(request.method === "HEAD" ? null : shell.body, {
    status: APP_PAGES.test(path) ? 200 : 404,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", ...NO_STORE },
  });
}

/** HMAC-SHA256 over `${timestamp}.${raw body}`, hex encoded; crypto.subtle.verify compares in constant time. */
async function verified(secret: string, timestamp: string, raw: ArrayBuffer, signature: string) {
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = new Uint8Array([...new TextEncoder().encode(`${timestamp}.`), ...new Uint8Array(raw)]);
  const bytes = new Uint8Array(signature.match(/../g)!.map(pair => parseInt(pair, 16)));
  return crypto.subtle.verify("HMAC", key, bytes, signed);
}
