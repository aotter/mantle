import { ContractError, type Caller } from "@aotter/mantle/contracts";
import confirmOrder from "../generated/procedures/confirm-order.js";

const MAX_BODY = 64 * 1024, MAX_SKEW_SECONDS = 300;

/**
 * App-owned routes, tried before Admin, MCP and REST. Return undefined to fall through.
 * POST /callbacks/supplier: the supplier confirms an order. The signature is checked over the RAW body before parsing.
 * AGENT: match the real supplier's signature scheme (header names, what is signed, encoding).
 */
export async function appRoutes(request: Request, env: Env, _context: { caller: () => Promise<Caller>; waitUntil: (task: Promise<unknown>) => void }): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== "/callbacks/supplier") return undefined;
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (Number(request.headers.get("content-length") ?? MAX_BODY + 1) > MAX_BODY) return new Response(null, { status: 413 });
  const raw = await request.arrayBuffer();
  const timestamp = request.headers.get("x-supplier-timestamp") ?? "";
  if (!(await verified(env.SUPPLIER_WEBHOOK_SECRET, timestamp, raw, request.headers.get("x-supplier-signature") ?? "")))
    return new Response(null, { status: 401 });

  let body: { reference?: unknown; orderId?: unknown };
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response(null, { status: 400 }); }
  if (typeof body.reference !== "string" || typeof body.orderId !== "string") return new Response(null, { status: 400 });
  try {
    // Trusted path: a system caller, after the signature proved the sender.
    await confirmOrder(env.DB, { kind: "system", reason: "supplier callback" }, { id: body.reference, supplierOrderId: body.orderId });
  } catch (error) {
    if (error instanceof ContractError && error.code === "CONFLICT") return new Response(null, { status: 409 }); // not 'ordered' (or a replay)
    throw error;
  }
  return new Response(null, { status: 204 });
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
