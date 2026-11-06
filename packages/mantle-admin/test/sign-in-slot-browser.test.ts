import { expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

// The `SignIn` slot (#1936): an application changes the email input's autocomplete, adds its own element, and runs its
// own step after an in-page sign-in before continuing to the same URL. A `passkey` method is listed for the slot to use;
// the default renders nothing for it and makes no WebAuthn request.
it("the SignIn slot sets the email autocomplete, adds the app's element and runs the app's step", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-sign-in-slot-"));
  const { buildAdmin } = await import("../dist/build/index.js");
  const dist = join(root, "admin"), entry = join(root, "entry.tsx");
  await writeFile(entry, `
import * as React from "react";
import { defineAdmin } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/index.js"))};
export default defineAdmin({}, {
  components: {
    SignIn: (props) => <>
      <p>app-sign-in-note {props.methods.map(m => m.kind).join(",")}</p>
      {props.renderDefault({ ...props, emailAutoComplete: "username webauthn",
        onSignedIn: next => window.location.assign("/admin/p/after?next=" + encodeURIComponent(next)) })}
    </>,
  },
  pages: [{ path: "after", title: "After", element: <p>after-step</p> }],
});
`);
  await buildAdmin({ entry, outDir: dist });
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let signedIn = false, methods: unknown[] = [{ kind: "email-otp" }, { kind: "passkey" }];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const json = (status: number, data: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    if (request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      posts.push({ path: url.pathname, body: JSON.parse(raw || "{}") });
    }
    if (url.pathname === "/api/auth/methods") return json(200, { methods });
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
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await browser.newPage(); page.setDefaultTimeout(15_000);
    await page.addInitScript(() => localStorage.setItem("cms.preference.language", "en"));

    // the slot sees every method, the app's autocomplete reaches the input, and the default offers no passkey UI
    await page.goto(origin + "/admin/sign-in");
    await page.getByText("app-sign-in-note email-otp,passkey").waitFor();
    expect(await page.getByRole("textbox").first().getAttribute("autocomplete")).toBe("username webauthn");
    expect(await page.getByRole("button", { name: /passkey/i }).count()).toBe(0);
    await page.waitForTimeout(300);
    expect(posts).toEqual([]);

    // the email code: the app's step gets Better Auth's continuation URL, unchanged
    await page.getByRole("textbox").first().fill("person@example.test");
    await page.getByRole("button", { name: "Send code" }).click();
    await page.getByRole("textbox").first().fill("123456");
    await page.getByText("after-step").waitFor();
    expect(new URL(page.url()).searchParams.get("next")).toBe("/admin/from-otp");

    // no server methods: the slot still mounts, so what the application adds still shows
    signedIn = false; methods = [];
    await page.goto(origin + "/admin/sign-in");
    await page.getByText("app-sign-in-note").waitFor();
    await page.getByText("No sign-in methods", { exact: false }).waitFor();
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 120_000);
