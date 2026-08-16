import { Hono } from "hono";
import type { HandlerFn } from "@aotter/mantle-runtime";
import type {
  CreateMantleWorkerOptions,
  MantleCloudflareEnv,
  MantleExtensionApp,
} from "../src/worker/createMantleWorker.js";
import { cloudflareTurnstileCheck } from "../src/handlers/turnstile.js";
import { createMantleWorker, runMantleWorkerRequest } from "../src/worker/index.js";

declare const app: MantleExtensionApp<MantleCloudflareEnv>;
type NoAssetsEnv = Omit<MantleCloudflareEnv, "ASSETS">;
declare const noAssetsOptions: CreateMantleWorkerOptions<NoAssetsEnv>;
const captchaCheck: HandlerFn<{ readonly turnstileToken?: string }, object, NoAssetsEnv> =
  cloudflareTurnstileCheck({ secret: "dev-stub" });

if (false) {
  void captchaCheck;
  void createMantleWorker<NoAssetsEnv>(noAssetsOptions);
  void runMantleWorkerRequest(() => new Response("ok"));
  app.get("/custom", (c) => c.text("ok"));
  app.route("/tools", new Hono<{ Bindings: MantleCloudflareEnv }>());
  app.route("/assets", new Hono());
  const dynamic: string = "/admin/dynamic";
  app.get(dynamic, (c) => c.text("runtime checked"));

  // @ts-expect-error Mantle owns the Admin namespace.
  app.get("/admin/settings", (c) => c.text("no"));
  // @ts-expect-error Mantle owns generated static assets.
  app.get("/_mantle/admin/index.html", (c) => c.text("no"));
  // @ts-expect-error Mantle owns the Auth namespace.
  app.post("/api/auth/callback", (c) => c.text("no"));
  // @ts-expect-error Mantle owns manifest View REST routes.
  app.get("/api/views/products", (c) => c.text("no"));
  // @ts-expect-error Mantle owns OAuth endpoints.
  app.get("/oauth/token", (c) => c.text("no"));
  // @ts-expect-error Mantle owns MCP endpoints.
  app.get("/mcp/staff", (c) => c.text("no"));
  // @ts-expect-error Mantle owns OAuth discovery endpoints.
  app.get("/.well-known/oauth-authorization-server", (c) => c.text("no"));
  app.get("/favicon.svg", (c) => c.text("consumer asset fallback"));
  // @ts-expect-error Global catch-alls could affect Core surfaces.
  app.all("*", (c) => c.text("no"));
}
