/** Real, English-only README screenshots from the checked revisions guide. Local test identity only; never deploy. */
import { spawn } from "node:child_process";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { prepareRevisionsExample } from "../packages/mantle-admin/test/fixtures/revisions-example";
import { buildAdmin } from "../packages/mantle-admin/dist/build/index.js";
import { chromium } from "../packages/mantle-admin/node_modules/playwright/index.mjs";

const root = resolve(import.meta.dirname, ".."), directory = await prepareRevisionsExample();
const output = resolve(root, "docs/assets/readme");
await mkdir(output, { recursive: true });
let backend: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await buildAdmin({ entry: join(directory, "src/admin.tsx"), mcpEntry: join(directory, "src/admin.mcp.tsx"), outDir: join(directory, "dist") });
  // Reuse the official browser-test server, its real Store/handlers and in-memory database.
  // Only sample copy and the deliberately oversized pagination fixture change for the tour.
  const fixture = resolve(root, "packages/mantle-admin/test/fixtures/revisions-server.ts");
  let server = await readFile(fixture, "utf8");
  server = server.replaceAll('"../../src/', JSON.stringify(resolve(root, "packages/mantle-admin/src") + "/").slice(0, -1))
    .replace('"../../tests/native/server-native-scenarios.js"', JSON.stringify(resolve(root, "packages/mantle-admin/tests/native/server-native-scenarios.ts")))
    .replace('slug: "hello"', 'slug: "publishing-with-confidence"')
    .replaceAll('"Published title"', '"Publishing without downtime"')
    .replaceAll('"Published body"', '"Keep the current article live while your team prepares the next revision."')
    .replaceAll('"Candidate title"', '"Review once. Publish with confidence."')
    .replaceAll('"Candidate body"', '"Preview the exact content you want to publish. Switching seals that revision and updates the live post together. Earlier revisions remain immutable rollback targets."')
    .replaceAll('"Reviewed summary"', '"A stable URL, an editable draft, and a safe switch to reviewed content."')
    .replace('for (let i = 0; i < 100; i++) await posts.insert({ slug: `filler-${i}` });', '')
    .replace('"/posts/hello"', '"/posts/publishing-with-confidence"');
  await writeFile(join(directory, "server.ts"), server);
  backend = spawn("bun", [join(directory, "server.ts"), directory], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; backend.stderr!.on("data", chunk => { errors += String(chunk); });
  const ready = await new Promise<{origin:string;post:string;first:string;second:string}>((done, reject) => {
    const timer = setTimeout(() => reject(Error(`Screenshot server timeout: ${errors}`)), 30_000);
    backend!.once("exit", code => { clearTimeout(timer); reject(Error(`Screenshot server exited ${code}: ${errors}`)); });
    let text = "";
    backend!.stdout!.on("data", chunk => { text += chunk; const line = text.split("\n").find(line => line.startsWith('{"origin":')); if (line) { clearTimeout(timer); done(JSON.parse(line)); } });
  });
  const {origin,post,second} = ready;
  browser = await chromium.launch({ headless: true, ...(process.env.MANTLE_TEST_CHROMIUM ? {executablePath:process.env.MANTLE_TEST_CHROMIUM} : {}) });
  const page = await browser.newPage({ viewport: {width:1600,height:1060}, deviceScaleFactor:1, locale:"en-US", colorScheme:"light" });
  page.setDefaultTimeout(20_000);
  await page.addInitScript(() => { localStorage.setItem("cms.preference.language", "en"); localStorage.setItem("cms.preference.theme", "light"); });
  const screenshot = async (name:string) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800); // Graph layout and transition settling; no DOM/image manipulation.
    const text = await page.locator("body").innerText();
    if (/[\u3400-\u9fff]/u.test(text)) throw Error(`Non-English text in ${name}`);
    await page.screenshot({path:join(output,name),animations:"disabled"});
    console.log(`Captured ${name}`);
  };
  await page.setViewportSize({width:1600,height:680});
  await page.goto(`${origin}/admin/c/posts/${post}?child=post_revisions`);
  await page.getByText("publishing-with-confidence",{exact:true}).first().waitFor();
  await screenshot("admin-workspace.png");
  await page.setViewportSize({width:1600,height:1000});
  await page.goto(`${origin}/admin/c/post_revisions/${second}/edit`);
  await page.getByRole("button",{name:"Unlock editing",exact:true}).click();
  await page.getByRole("button",{name:"Save changes",exact:true}).waitFor();
  await screenshot("revision-editor.png");
  await page.goto(`${origin}/admin/p/revisions?post=${post}`);
  await page.getByLabel("Revision",{exact:true}).selectOption(second);
  await page.getByRole("button",{name:"Preview selected revision",exact:true}).click();
  await page.getByRole("heading",{name:"Review once. Publish with confidence.",exact:true}).waitFor();

  await page.getByRole("button",{name:"Switch to reviewed revision",exact:true}).click();
  await page.getByRole("status").filter({hasText:"Revision selected"}).waitFor();
  const state = await (await fetch(`${origin}/test/state`)).json();
  if(state.post.current_revision!==second || !state.second.sealed)throw Error("Revision switch did not commit");
  console.log("Verified: reviewed revision selected and sealed by the real handler");
  await page.setViewportSize({width:1600,height:800});
  await page.goto(`${origin}/admin/dev`);
  await page.locator(".react-flow__node").first().waitFor();
  await screenshot("system-wiring.png");
  await page.goto(`${origin}/admin/dev/overview/relationships`);
  await page.locator(".react-flow__node").first().waitFor();
  await screenshot("entity-relationships.png");
  await page.setViewportSize({width:1600,height:1060});
  await page.goto(`${origin}/admin/dev/logic/procedures?selected=Procedure%3Anew-revision`);
  await page.locator(".react-flow__node").first().waitFor();
  await screenshot("procedure-chart.png");
} finally {
  await browser?.close();
  if(backend && backend.exitCode===null){backend.kill("SIGTERM");await new Promise<void>(done=>backend!.once("exit",()=>done()));}
  await rm(directory,{recursive:true,force:true});
}
