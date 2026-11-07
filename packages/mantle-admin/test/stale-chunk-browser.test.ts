import { expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

// After a deploy the old build's chunks are gone. A page whose lazy chunk 404s reloads once, and only once.
it("Admin reloads once when a content-hashed chunk is missing, then lets the failure surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-stale-chunk-"));
  const { buildAdmin } = await import("../dist/build/index.js");
  const dist = join(root, "admin"), entry = join(root, "entry.tsx");
  await writeFile(entry, `import { defineAdmin } from ${JSON.stringify(resolve(import.meta.dirname, "../dist/admin-app/index.js"))};\nexport default defineAdmin({});\n`);
  await buildAdmin({ entry, outDir: dist });
  // the zh-TW messages are a lazy chunk; remove it as a deploy would
  const chunk = (await readdir(join(dist, "assets"))).find(name => /^zh-TW-.*\.js$/.test(name));
  expect(chunk).toBeTruthy();
  await rm(join(dist, "assets", chunk!));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const json = (status: number, data: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    if (url.pathname === "/api/auth/methods") return json(200, { methods: [{ kind: "email-otp" }] });
    if (url.pathname === "/admin/api/me") return json(401, { error: { code: "UNAUTHENTICATED", message: "Sign in" } });
    if (url.pathname.startsWith("/admin/api/")) return json(200, {});
    try {
      const path = url.pathname.slice("/admin/".length);
      if (/^[\w/-]+\.(?:js|css|svg)$/.test(path)) {
        response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "image/svg+xml");
        response.end(await readFile(resolve(dist, path))); return;
      }
      response.setHeader("content-type", "text/html"); response.end(await readFile(join(dist, "index.html")));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("cms.preference.language", "zh-TW");
      sessionStorage.setItem("loads", String(Number(sessionStorage.getItem("loads") ?? 0) + 1));
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/admin/sign-in");
    // the first load fails on the missing chunk and reloads; the second fails the same way and does not
    await page.waitForFunction(() => sessionStorage.getItem("loads") === "2", undefined, { timeout: 15_000 });
    await page.waitForTimeout(1_500);
    expect(await page.evaluate(() => sessionStorage.getItem("loads"))).toBe("2");
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
}, 120_000);
