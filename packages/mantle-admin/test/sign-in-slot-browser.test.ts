import { expect, it } from "vitest";
import { chromium } from "playwright";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

// The `SignIn` slot and the passkey method (#1936): an application changes the email input's autocomplete, adds its
// own element, and runs its own step after an in-page sign-in before continuing to the same URL. Better Auth's passkey
// endpoints are fixtures here: the browser's real WebAuthn API (Chromium's virtual authenticator) signs the assertion,
// and the test checks what reaches the server, not Better Auth's verification.
it("the SignIn slot sets the email autocomplete, signs in with a passkey and runs the app's step before continuing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-sign-in-slot-"));
  const { buildAdmin } = await import("../dist/build/index.js");
  const dist = join(root, "admin"), entry = join(root, "entry.tsx");
  await writeFile(entry, `
import * as React from "react";
import { defineAdmin } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/index.js"))};
export default defineAdmin({}, {
  components: {
    SignIn: (props) => <>
      <p>app-sign-in-note</p>
      {props.renderDefault({ ...props, emailAutoComplete: "username webauthn",
        onSignedIn: next => window.location.assign("/admin/p/after?next=" + encodeURIComponent(next)) })}
    </>,
  },
  pages: [{ path: "after", title: "After", element: <p>after-step</p> }],
});
`);
  await buildAdmin({ entry, outDir: dist });
  const rpId = "localhost", challenge = randomBytes(32).toString("base64url"), credentialId = randomBytes(16);
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let signedIn = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const json = (status: number, data: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    if (request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      posts.push({ path: url.pathname, body: JSON.parse(raw || "{}") });
    }
    if (url.pathname === "/api/auth/methods") return json(200, { methods: [{ kind: "email-otp" }, { kind: "passkey" }] });
    if (url.pathname === "/api/auth/passkey/generate-authenticate-options") return json(200, { challenge, rpId, timeout: 60000, userVerification: "preferred", allowCredentials: [] });
    if (url.pathname === "/api/auth/passkey/verify-authentication") { signedIn = true; return json(200, { session: {} }); }
    if (url.pathname === "/api/auth/email-otp/send-verification-otp") return json(200, { success: true });
    if (url.pathname === "/api/auth/sign-in/email-otp") { signedIn = true; return json(200, { url: "/admin/from-otp" }); }
    if (url.pathname === "/admin/api/me") return signedIn ? json(200, { role: "admin", admin: true, login: "fixture", image: null }) : json(401, { error: { code: "UNAUTHENTICATED", message: "Sign in" } });
    if (url.pathname.startsWith("/admin/api/")) {
      const fixed: Record<string, unknown> = {
        "/admin/api/site": { brand: "Fixture", icons: [], locales: ["en"], canonicalLocale: "en" },
        "/admin/api/collections": { collections: [], allCollections: {} }, "/admin/api/operations": { operations: [] },
        "/admin/api/views-manifest": { views: [] }, "/admin/api/webmcp": { tools: [], routes: {} },
      };
      return json(200, fixed[url.pathname] ?? {});
    }
    try {
      const path = url.pathname.slice("/admin/".length);
      if (/^[\w/-]+\.(?:js|css|svg)$/.test(path)) {
        response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "image/svg+xml");
        response.end(await readFile(resolve(dist, path))); return;
      }
      response.setHeader("content-type", "text/html"); response.end(await readFile(join(dist, "index.html")));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    // `localhost`, not an IP address: an RP ID must be a domain.
    const origin = `http://localhost:${(server.address() as { port: number }).port}`;
    const page = await browser.newPage(); page.setDefaultTimeout(15_000);
    await page.addInitScript(() => localStorage.setItem("cms.preference.language", "en"));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: {
      credentialId: credentialId.toString("base64"), isResidentCredential: true, rpId, userHandle: Buffer.from("user-1").toString("base64"),
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), signCount: 0 } });

    await page.goto(origin + "/admin/sign-in");
    await page.getByText("app-sign-in-note").waitFor();
    expect(await page.getByRole("textbox").first().getAttribute("autocomplete")).toBe("username webauthn");

    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByText("after-step").waitFor();
    // the app's step ran with where Admin would have gone, unchanged
    expect(new URL(page.url()).searchParams.get("next")).toBe("/admin");
    const verify = posts.find(post => post.path === "/api/auth/passkey/verify-authentication")!;
    const assertion = verify.body.response as { id: string; type: string; response: Record<string, string> };
    expect(assertion.id).toBe(credentialId.toString("base64url"));
    expect(assertion.type).toBe("public-key");
    expect(Object.keys(assertion.response).sort()).toEqual(expect.arrayContaining(["authenticatorData", "clientDataJSON", "signature"]));
    // the browser signed the server's challenge for this origin
    const client = JSON.parse(Buffer.from(assertion.response.clientDataJSON!, "base64url").toString()) as { challenge: string; origin: string; type: string };
    expect(client).toMatchObject({ challenge, origin, type: "webauthn.get" });
    expect(verify.body).not.toHaveProperty("oauth_query");

    // the email code takes the same path: the app's step gets Better Auth's continuation URL
    signedIn = false;
    await page.goto(origin + "/admin/sign-in");
    await page.getByRole("textbox").first().fill("person@example.test");
    await page.getByRole("button", { name: "Send code" }).click();
    await page.getByRole("textbox").first().fill("123456");
    await page.getByText("after-step").waitFor();
    expect(new URL(page.url()).searchParams.get("next")).toBe("/admin/from-otp");
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 120_000);
