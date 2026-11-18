import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { uploadMedia } from "@aotter/mantle/media";
import type { MediaLibrary } from "@aotter/mantle/site";

const body = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const transparent = (html: HTMLElement) => [
  getComputedStyle(html).backgroundColor,
  getComputedStyle(document.body).backgroundColor,
  document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
];

// `tool` and `forward`: the card calls its own tool and repeats `folder` from the tool input.
// No tool input: after `inputTimeoutMs` the card calls without `folder` and shows the refusal.
// A late tool input: the card reads the purposes again with it and the upload carries it.
// `anyFile`: a purpose that takes any type gets a PDF, with no alt text.
it.each([
  {},
  { localeSwitch: true },
  { tool: "upload_to_folder", forward: ["folder"] },
  { forward: ["folder"], inputTimeoutMs: 300, silent: true },
  { forward: ["folder"], inputTimeoutMs: 300, late: true },
  { anyFile: true },
  { choosePurpose: true },
])(
  "the upload card PUTs the picked file to storage through CORS and commits it (%o)",
  async ({
    silent,
    late,
    anyFile,
    choosePurpose,
    localeSwitch,
    ...options
  }: {
    tool?: string;
    forward?: string[];
    inputTimeoutMs?: number;
    silent?: boolean;
    late?: boolean;
    anyFile?: boolean;
    choosePurpose?: boolean;
    localeSwitch?: boolean;
  }) => {
    anyFile ||= choosePurpose;
    const TOOL = options.tool ?? "open_media_upload",
      extra = options.forward ? { folder: "docs" } : {},
      purpose = anyFile ? "notes" : "cover",
      filename = localeSwitch ? "檔案 & {id}.png" : "c\u200Bat.png";
    const root = resolve(import.meta.dirname, "../../.."),
      pkg = resolve(import.meta.dirname, "..");
    const { build } = createRequire(resolve(root, "packages/mantle/package.json"))("esbuild");
    const require = createRequire(resolve(pkg, "package.json"));
    // the built card, as `mediaUploadCard` serves it on resources/read
    const { mediaUploadCard } = await import("../dist/server/mcp.js");
    let origin = "";
    const card = mediaUploadCard({ media: () => ({ uploadOrigin: origin }), ...options }).resources[0]!;
    expect(card).toMatchObject({ uri: "ui://mantle-admin/upload", renders: [TOOL] });
    const host = await build({
      stdin: {
        contents: `
import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const frame=document.createElement('iframe');frame.sandbox='allow-scripts';document.body.append(frame);
window.host={calls:[],messages:[]};
const bridge=new AppBridge(null,{name:'upload-test',version:'1'},{serverTools:{},message:{text:{}}},{hostContext:{theme:'light',locale:${JSON.stringify(localeSwitch ? "zh-Hant-HK" : "en")}}});
window.host.bridge=bridge;
bridge.oninitialized=()=>{window.host.appCapabilities=bridge.getAppCapabilities();${silent ? "" : late ? "setTimeout(()=>void bridge.sendToolInput({arguments:{purpose:'cover',folder:'docs'}}),800);" : `void bridge.sendToolInput({arguments:{${choosePurpose ? "" : `purpose:'${purpose}',`}folder:'docs'}});`}};
bridge.oncalltool=async params=>{window.host.calls.push(params);
if(${!!localeSwitch}&&params.arguments?.variants)await new Promise(resolve=>window.host.releasePrepare=resolve);
if(${!!localeSwitch}&&params.arguments?.uploadId)await new Promise(resolve=>window.host.releaseCommit=resolve);
return (await fetch('/tool',{method:'POST',body:JSON.stringify(params)})).json();};
bridge.onmessage=async params=>{window.host.messages.push(params);return {};};
bridge.onsizechange=()=>{};
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/card';
`,
        resolveDir: pkg,
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      alias: {
        "@modelcontextprotocol/ext-apps/app-bridge": require.resolve("@modelcontextprotocol/ext-apps/app-bridge"),
      },
    });
    // a stub library over a stub bucket: commit succeeds only for the object that was PUT
    const objects = new Map<string, { type: string; bytes: Buffer }>(),
      pending = new Map<string, { type: string; size: number }>(),
      preflights: (string | undefined)[] = [];
    const library = {
      async createUpload(request: { variants: { mimeType: string; byteSize: number; role: "primary" }[] }) {
        const id = crypto.randomUUID(),
          [variant] = request.variants;
        pending.set(id, { type: variant!.mimeType, size: variant!.byteSize });
        return {
          uploadGroupId: id,
          expiresAt: Date.now() + 900_000,
          capabilities: [
            {
              ...variant!,
              method: "PUT" as const,
              uploadUrl: `${origin}/storage/${id}`,
              requiredHeaders: { "Content-Type": variant!.mimeType },
            },
          ],
        };
      },
      async commitUpload(id: string) {
        const object = objects.get(id),
          expected = pending.get(id);
        if (!object || object.type !== expected?.type || object.bytes.length !== expected.size)
          throw new Error("not uploaded");
        return {
          id,
          createdAt: 1,
          variants: [
            {
              mimeType: object.type,
              role: "primary",
              byteSize: object.bytes.length,
              storageKey: id,
              publicUrl: `${origin}/media/${id}`,
            },
          ],
        };
      },
    } as unknown as MediaLibrary;
    const policies = [
      { name: "cover", required: ["image/png,image/jpeg"], maxBytes: { "image/png": 1000, "image/jpeg": 1000 } },
      { name: "gallery", required: ["image/webp", "image/jpeg"], maxBytes: { "image/webp": 1000, "image/jpeg": 1000 } },
      { name: "notes", required: ["*/*"], maxBytes: { "*/*": 1000 } },
    ];
    let releaseStorage!: () => void;
    const storageReleased = new Promise<void>(resolve => {
      releaseStorage = resolve;
    });
    const server = createServer(async (request, response) => {
      const url = request.url ?? "/";
      if (url === "/release-storage") {
        releaseStorage();
        response.end();
        return;
      }
      if (url.startsWith("/storage/")) {
        // the CORS a bucket needs: PUT from the host's sandbox origin, keyed on Origin (an opaque sandbox sends "null")
        response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
        response.setHeader("vary", "Origin");
        if (request.method === "OPTIONS") {
          preflights.push(request.headers.origin);
          response.setHeader("access-control-allow-methods", "PUT");
          response.setHeader("access-control-allow-headers", "content-type");
          response.end();
          return;
        }
        objects.set(url.slice("/storage/".length), {
          type: String(request.headers["content-type"]),
          bytes: await body(request),
        });
        if (localeSwitch) await storageReleased;
        response.end();
        return;
      }
      if (url === "/tool") {
        const {
          name,
          arguments: { folder, ...args },
        } = JSON.parse(String(await body(request)));
        try {
          if (name !== TOOL || folder !== (options.forward ? "docs" : undefined))
            throw new Error(`unexpected call ${name} ${folder}`);
          const out = (await uploadMedia(library, policies, args, { apps: true })) as Record<string | symbol, unknown>;
          const [data, meta] = Symbol.for("net.aotter.mantle/result") in out ? [out.data, out._meta] : [out, undefined];
          response.end(
            JSON.stringify({
              content: [{ type: "text", text: JSON.stringify(data) }],
              structuredContent: data,
              ...(meta ? { _meta: meta } : {}),
            }),
          );
        } catch (error) {
          const diagnostics = [{ code: "FAILED", message: error instanceof Error ? error.message : String(error) }];
          response.end(
            JSON.stringify({
              isError: true,
              content: [{ type: "text", text: JSON.stringify({ diagnostics }) }],
              structuredContent: { diagnostics },
            }),
          );
        }
        return;
      }
      if (url === "/card") {
        const page = await (card.html as (render: unknown) => Promise<{ html: string; csp: unknown }>)({
          env: {},
          tools: new Set([TOOL]),
          request: new Request(`${origin}/mcp/admin`),
        });
        expect(page.csp).toEqual({ connectDomains: [origin] });
        response.setHeader("content-type", "text/html");
        response.end(page.html);
        return;
      }
      response.setHeader("content-type", url === "/host.js" ? "text/javascript" : "text/html");
      response.end(
        url === "/host.js"
          ? host.outputFiles[0]!.text
          : '<!doctype html><script type="module" src="/host.js"></script>',
      );
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({
      channel: "chrome",
      executablePath: process.env.MANTLE_TEST_CHROMIUM,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin);
      const app = page.frameLocator("iframe");
      const upload = app.locator("#upload");
      if (silent) {
        await expect.poll(() => app.locator("#status").textContent()).toBe(`unexpected call ${TOOL} undefined`);
        expect(await app.locator("#status").getAttribute("role")).toBe("alert");
        const { calls } = await page.evaluate(() => (window as unknown as { host: { calls: unknown[] } }).host);
        expect(calls).toMatchObject([{ name: TOOL, arguments: {} }]);
        expect(errors).toEqual([]);
        return;
      }
      await expect.poll(() => app.locator("form").getAttribute("aria-busy"), { timeout: 10_000 }).toBe("false");
      if (localeSwitch) {
        expect(await app.locator("h1").textContent()).toBe("上傳檔案");
        expect(await app.locator("#file").getAttribute("aria-label")).toBe("檔案");
        expect(await app.locator(".footnote").textContent()).toContain("上傳完成前");
        expect(await app.locator("#policy").textContent()).toContain("位元組");
        await page.evaluate(() => (window as any).host.bridge.setHostContext({ locale: "fr-FR" }));
        await expect.poll(() => app.locator("h1").textContent()).toBe("Upload a file");
      }
      expect(await upload.isDisabled()).toBe(true);
      expect(await app.locator("#file-details").textContent()).toBe("No file selected");
      // the conversation shows through, and the first paint takes the host's scheme
      expect(await app.locator("html").evaluate(transparent)).toEqual([
        "rgba(0, 0, 0, 0)",
        "rgba(0, 0, 0, 0)",
        "light dark",
      ]);
      // The real host bridge changes the shared kit tokens, while neutral host styles leave the primary action branded.
      for (const [theme, primary] of [
        ["dark", "rgb(52, 80, 147)"],
        ["light", "rgb(26, 48, 98)"],
      ] as const) {
        await page.evaluate(theme => (window as any).host.bridge.setHostContext({ theme }), theme);
        await expect.poll(() => app.locator("html").getAttribute("data-theme")).toBe(theme);
        expect(await upload.evaluate(button => getComputedStyle(button).backgroundColor)).toBe(primary);
        expect(await upload.evaluate(button => getComputedStyle(button).color)).toBe("rgb(255, 255, 255)");
      }
      await page.evaluate(() =>
        (window as any).host.bridge.setHostContext({
          styles: {
            variables: {
              "--color-background-secondary": "rgb(230, 235, 240)",
              "--color-text-primary": "rgb(20, 25, 30)",
            },
          },
        }),
      );
      await expect
        .poll(() => app.locator(".file-panel").evaluate(panel => getComputedStyle(panel).backgroundColor))
        .toBe("rgb(230, 235, 240)");
      expect(await upload.evaluate(button => getComputedStyle(button).backgroundColor)).toBe("rgb(26, 48, 98)");
      // A single native file control covers the secondary picker surface; Upload remains a separate primary action.
      expect(await app.locator('input[type="file"]').count()).toBe(1);
      expect(await app.locator("button").count()).toBe(1);
      await app.getByLabel("File", { exact: true }).focus();
      expect(await app.locator(".file-picker").evaluate(picker => getComputedStyle(picker).outlineStyle)).toBe("solid");
      // the purpose came in the tool input, so no picker shows; the input accepts its types, or any file
      expect(await app.locator("#purpose-row").isHidden()).toBe(!choosePurpose);
      if (choosePurpose) await app.getByLabel("Purpose").selectOption("notes");
      expect(await app.getByLabel("File").getAttribute("accept")).toBe(anyFile ? "" : "image/png,image/jpeg");
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56)]),
        pdf = Buffer.from("%PDF-1.7\n%%EOF\n");
      if (anyFile) {
        // alt text is for images: a PDF gets none
        await app.getByLabel("File").setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: pdf });
        expect(await app.locator("#alt-row").isHidden()).toBe(true);
        expect(await app.locator("#file-details").textContent()).toContain("report.pdf");
        expect(await app.getByLabel("Purpose").inputValue()).toBe("notes");
      } else {
        // a type the purpose does not take is refused before any call
        await app
          .getByLabel("File")
          .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
        expect(await app.locator("#alt-row").isHidden()).toBe(true);
        await upload.click();
        await expect.poll(() => app.locator("#status").textContent()).toContain("takes image/png or image/jpeg");
        expect(await app.locator("#status").getAttribute("role")).toBe("alert");
        if (localeSwitch) {
          await page.evaluate(() => (window as any).host.bridge.setHostContext({ locale: "zh-Hans" }));
          await expect.poll(() => app.locator("#status").textContent()).toContain("不接受 text/plain");
          expect(await upload.textContent()).toBe("重试");
        }
        // Raw identity is preserved, including template-looking text; the bridge only normalizes invisible message text.
        await app.locator("#file").setInputFiles({ name: filename, mimeType: "image/png", buffer: png });
        await app.locator("#alt").fill("A cat");
        if (localeSwitch) {
          await page.evaluate(() => (window as any).host.bridge.setHostContext({ locale: "zh-TW" }));
          await expect.poll(() => app.locator("#file").getAttribute("aria-label")).toBe("檔案");
          expect(await app.locator("#file-details").textContent()).toContain(filename);
          expect(await app.locator("#alt").inputValue()).toBe("A cat");
        }
      }
      await upload.click();
      if (localeSwitch) {
        await expect.poll(() => upload.textContent()).toBe("準備中…");
        expect(await app.locator("#status").textContent()).toBe("準備中…");
        await page.evaluate(() => (window as any).host.bridge.setHostContext({ locale: "zh-CN" }));
        await expect.poll(() => upload.textContent()).toBe("准备中…");
        await page.evaluate(() => (window as any).host.bridge.setHostContext({ theme: "dark" }));
        await expect.poll(() => app.locator("html").getAttribute("data-theme")).toBe("dark");
        expect(await app.locator("#file").getAttribute("aria-label")).toBe("文件");
        await page.evaluate(() => (window as any).host.releasePrepare());
        await expect.poll(() => upload.textContent()).toBe("上传中…");
        expect(await app.locator("#status").textContent()).toBe(`正在上传 ${filename}…`);
        expect(await app.locator("#progress").getAttribute("aria-label")).toBe("上传进度");
        await page.evaluate(() => (window as any).host.bridge.setHostContext({ locale: "zh-TW" }));
        await expect.poll(() => upload.textContent()).toBe("上傳中…");
        expect(await app.locator("#file").evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe(filename);
        await page.request.get(origin + "/release-storage");
        await expect.poll(() => upload.textContent()).toBe("儲存中…");
        expect(await app.locator("#status").textContent()).toBe("正在儲存…");
        await page.evaluate(() => (window as any).host.releaseCommit());
      }
      await app.getByText(localeSwitch ? /^上傳完成。素材 ID：/ : /^Uploaded\. Asset id /).waitFor({ timeout: 10_000 });
      await expect.poll(() => upload.textContent()).toBe(localeSwitch ? "已上傳" : "Uploaded");
      const id = (await app.locator("form").getAttribute("data-asset"))!;
      expect(objects.get(id)).toEqual(
        anyFile ? { type: "application/pdf", bytes: pdf } : { type: "image/png", bytes: png },
      );
      expect(preflights).toEqual(["null"]);
      const { calls, messages, appCapabilities } = await page.evaluate(
        () => (window as unknown as { host: { calls: unknown[]; messages: unknown[]; appCapabilities: unknown } }).host,
      );
      // the card shows no View: it lists no app tools for the host to route a call to
      expect(appCapabilities).not.toHaveProperty("tools");
      expect(
        calls.map(call => ({
          name: (call as { name: string }).name,
          arguments: (call as { arguments: unknown }).arguments,
        })),
      ).toEqual([
        // a late input: the first read went without it and was refused, then the purposes were read again with it
        ...(late ? [{ name: TOOL, arguments: {} }] : []),
        { name: TOOL, arguments: { ...extra } },
        {
          name: TOOL,
          arguments: anyFile
            ? {
                purpose,
                filename: "report.pdf",
                variants: [{ mimeType: "application/pdf", byteSize: pdf.length, role: "primary" }],
              }
            : {
                purpose,
                filename,
                variants: [{ mimeType: "image/png", byteSize: 64, role: "primary" }],
                alt: "A cat",
                ...extra,
              },
        },
        { name: TOOL, arguments: { uploadId: id, purpose, ...extra } },
      ]);
      expect(messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: localeSwitch
                ? `我已將 ${filename} 上傳至媒體庫：素材 ID ${id}（用途 ${purpose}）。`
                : `I uploaded ${anyFile ? "report.pdf" : "cat.png"} to the media library: asset id ${id} (purpose ${purpose}).`,
            },
          ],
        },
      ]);
      if (localeSwitch) {
        await page.evaluate(() => (window as any).host.bridge.setHostContext({ locale: "de-DE" }));
        await expect.poll(() => app.locator("#status").textContent()).toBe(`Uploaded. Asset id ${id}.`);
        expect(await app.locator("#file-details").textContent()).toContain(filename);
      }
      // a finished upload offers no second upload of the same file
      expect(await upload.isDisabled()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>(done => server.close(() => done()));
    }
  },
  60_000,
);
