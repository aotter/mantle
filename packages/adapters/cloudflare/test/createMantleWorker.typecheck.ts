import { Hono } from "hono";
import type { EmailSender, HandlerFn } from "@aotter/mantle-runtime";
import type {
  CreateMantleWorkerOptions,
  MantleCloudflareEnv,
  MantleExtensionApp,
} from "../src/worker/createMantleWorker.js";
import { cloudflareTurnstileCheck } from "../src/handlers/turnstile.js";
import { createMantleWorker, runMantleWorkerRequest } from "../src/worker/index.js";
import { createAuth, type AuthMethodConfig } from "../src/auth/createAuth.js";

declare const app: MantleExtensionApp<MantleCloudflareEnv>;
type NoAssetsEnv = Omit<MantleCloudflareEnv, "ASSETS">;
declare const noAssetsOptions: CreateMantleWorkerOptions<NoAssetsEnv>;
declare const authDb: D1Database;
declare const emailSender: EmailSender;
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
  app.get("/oauth/consent", (c) => c.text("no"));
  // @ts-expect-error Mantle owns MCP endpoints.
  app.get("/mcp/staff", (c) => c.text("no"));
  // @ts-expect-error Mantle owns OAuth discovery endpoints.
  app.get("/.well-known/oauth-authorization-server", (c) => c.text("no"));
  app.get("/favicon.ico", (c) => c.text("consumer icon override"));
  app.get("/favicon.svg", (c) => c.text("consumer asset fallback"));
  // @ts-expect-error Global catch-alls could affect Core surfaces.
  app.all("*", (c) => c.text("no"));

  createAuth({
    database: authDb,
    baseURL: "https://example.test",
    secret: "x".repeat(40),
    methods: [
      { kind: "social", provider: "google", options: { clientId: "g", clientSecret: "g", accessType: "offline" } },
      { kind: "social", provider: "facebook", options: { clientId: "f", clientSecret: "f", fields: ["email"] } },
      { kind: "social", provider: "apple", options: async () => ({ clientId: "a", clientSecret: "a" }) },
      { kind: "oauth", options: { providerId: "custom", clientId: "c", discoveryUrl: "https://idp.test/.well-known/openid-configuration", accessType: "offline" } },
      { kind: "email-otp", sender: emailSender, options: { storeOTP: { hash: async (otp) => `hash:${otp}` } } },
      { kind: "magic-link", sender: emailSender, options: { storeToken: { type: "custom-hasher", hash: async (token) => `hash:${token}` } } },
    ],
  });

  const invalidGoogle: AuthMethodConfig = {
    kind: "social",
    provider: "google",
    // @ts-expect-error Facebook-only fields must not widen into Google options.
    options: { clientId: "g", clientSecret: "g", fields: ["email"] },
  };
  void invalidGoogle;
}
