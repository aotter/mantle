import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { uploadMedia } from "@aotter/mantle/media";
import type { MediaLibrary } from "@aotter/mantle/site";

const body = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };

it("the upload card PUTs the picked image to storage through CORS and commits it with upload_media", async () => {
  const root = resolve(import.meta.dirname, "../../.."), pkg = resolve(import.meta.dirname, "..");
  const { build } = createRequire(resolve(root, "packages/mantle/package.json"))("esbuild");
  const require = createRequire(resolve(pkg, "package.json"));
  // the built card, as `mediaUploadCard` serves it on resources/read
  const { mediaUploadCard } = await import("../dist/server/mcp.js");
  let origin = "";
  const card = mediaUploadCard({ media: () => ({ uploadOrigin: origin }) }).resources[0]!;
  expect(card).toMatchObject({ uri: "ui://mantle-admin/upload", renders: ["upload_media"] });
  const host = await build({ stdin: { contents: `
import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const frame=document.createElement('iframe');frame.sandbox='allow-scripts';document.body.append(frame);
window.host={calls:[],messages:[]};
const bridge=new AppBridge(null,{name:'upload-test',version:'1'},{serverTools:{},message:{text:{}}},{hostContext:{}});
bridge.oninitialized=()=>{void bridge.sendToolInput({arguments:{purpose:'cover'}});};
bridge.oncalltool=async params=>{window.host.calls.push(params);return (await fetch('/tool',{method:'POST',body:JSON.stringify(params)})).json();};
bridge.onmessage=async params=>{window.host.messages.push(params);return {};};
bridge.onsizechange=()=>{};
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/card';
`, resolveDir: pkg }, bundle: true, write: false, platform: "browser", format: "esm", alias: { "@modelcontextprotocol/ext-apps/app-bridge": require.resolve("@modelcontextprotocol/ext-apps/app-bridge") } });
  // a stub library over a stub bucket: commit succeeds only for the object that was PUT
  const objects = new Map<string, { type: string; bytes: Buffer }>(), pending = new Map<string, { type: string; size: number }>(), preflights: (string | undefined)[] = [];
  const library = {
    async createUpload(request: { variants: { mimeType: string; byteSize: number; role: "primary" }[] }) {
      const id = crypto.randomUUID(), [variant] = request.variants;
      pending.set(id, { type: variant!.mimeType, size: variant!.byteSize });
      return { uploadGroupId: id, expiresAt: Date.now() + 900_000, capabilities: [{ ...variant!, method: "PUT" as const, uploadUrl: `${origin}/storage/${id}`, requiredHeaders: { "Content-Type": variant!.mimeType } }] };
    },
    async commitUpload(id: string) {
      const object = objects.get(id), expected = pending.get(id);
      if (!object || object.type !== expected?.type || object.bytes.length !== expected.size) throw new Error("not uploaded");
      return { id, createdAt: 1, variants: [{ mimeType: object.type, role: "primary", byteSize: object.bytes.length, storageKey: id, publicUrl: `${origin}/media/${id}` }] };
    },
  } as unknown as MediaLibrary;
  const policies = [{ name: "cover", required: ["image/png,image/jpeg"], maxBytes: { "image/png": 1000, "image/jpeg": 1000 } }, { name: "gallery", required: ["image/webp", "image/jpeg"], maxBytes: { "image/webp": 1000, "image/jpeg": 1000 } }];
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/storage/")) {
      // the CORS a bucket needs: PUT from the host's sandbox origin, keyed on Origin (an opaque sandbox sends "null")
      response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
      response.setHeader("vary", "Origin");
      if (request.method === "OPTIONS") { preflights.push(request.headers.origin); response.setHeader("access-control-allow-methods", "PUT"); response.setHeader("access-control-allow-headers", "content-type"); response.end(); return; }
      objects.set(url.slice("/storage/".length), { type: String(request.headers["content-type"]), bytes: await body(request) });
      response.end();
      return;
    }
    if (url === "/tool") {
      const { name, arguments: args } = JSON.parse(String(await body(request)));
      try {
        if (name !== "upload_media") throw new Error(`unknown tool ${name}`);
        const out = await uploadMedia(library, policies, args, { apps: true }) as Record<string | symbol, unknown>;
        const [data, meta] = Symbol.for("net.aotter.mantle/result") in out ? [out.data, out._meta] : [out, undefined];
        response.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, ...(meta ? { _meta: meta } : {}) }));
      } catch (error) {
        const diagnostics = [{ code: "FAILED", message: error instanceof Error ? error.message : String(error) }];
        response.end(JSON.stringify({ isError: true, content: [{ type: "text", text: JSON.stringify({ diagnostics }) }], structuredContent: { diagnostics } }));
      }
      return;
    }
    if (url === "/card") {
      const page = await (card.html as (render: unknown) => Promise<{ html: string; csp: unknown }>)({ env: {}, tools: new Set(["upload_media"]), request: new Request(`${origin}/mcp/admin`) });
      expect(page.csp).toEqual({ connectDomains: [origin] });
      response.setHeader("content-type", "text/html");
      response.end(page.html);
      return;
    }
    response.setHeader("content-type", url === "/host.js" ? "text/javascript" : "text/html");
    response.end(url === "/host.js" ? host.outputFiles[0]!.text : '<!doctype html><script type="module" src="/host.js"></script>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    const app = page.frameLocator("iframe");
    const upload = app.getByRole("button", { name: "Upload" });
    await expect.poll(() => upload.isEnabled()).toBe(true);
    // the purpose came in the tool input, so no picker shows; the input accepts its types
    expect(await app.locator("#purpose-row").isHidden()).toBe(true);
    expect(await app.getByLabel("Image").getAttribute("accept")).toBe("image/png,image/jpeg");
    // a type the purpose does not take is refused before any call
    await app.getByLabel("Image").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await upload.click();
    await expect.poll(() => app.locator("#status").textContent()).toContain("takes image/png or image/jpeg");
    expect(await app.locator("#status").getAttribute("role")).toBe("alert");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56)]);
    await app.getByLabel("Image").setInputFiles({ name: "cat.png", mimeType: "image/png", buffer: png });
    await app.getByLabel("Alt text").fill("A cat");
    await upload.click();
    await app.getByText(/^Uploaded\. Asset id /).waitFor();
    const id = (await app.locator("form").getAttribute("data-asset"))!;
    expect(objects.get(id)).toEqual({ type: "image/png", bytes: png });
    expect(preflights).toEqual(["null"]);
    const { calls, messages } = await page.evaluate(() => (window as unknown as { host: { calls: unknown[]; messages: unknown[] } }).host);
    expect(calls.map(call => ({ name: (call as { name: string }).name, arguments: (call as { arguments: unknown }).arguments }))).toEqual([
      { name: "upload_media", arguments: {} },
      { name: "upload_media", arguments: { purpose: "cover", filename: "cat.png", variants: [{ mimeType: "image/png", byteSize: 64, role: "primary" }], alt: "A cat" } },
      { name: "upload_media", arguments: { uploadId: id, purpose: "cover" } },
    ]);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: `I uploaded cat.png to the media library: asset id ${id} (purpose cover).` }] }]);
    // a finished upload offers no second upload of the same file
    expect(await upload.isDisabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }
}, 60_000);
