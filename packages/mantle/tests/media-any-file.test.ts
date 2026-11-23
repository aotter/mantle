import { fixtureCaller } from "./apps/fixtures.js";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import postgres from "postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { writeGenerated } from "./apps/link.js";
import { d1Shim } from "./apps/d1-shim.js";
import { r2MediaStorage, type R2Bucket } from "../src/kernel/r2-media.js";
import type { Target } from "../src/domain/model.js";
import type { MediaPurposePolicy } from "../src/kernel/site-types.js";
import { mcpInit } from "./mcp-wire.js";

const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec: {title: Notes, lifecycle: operational, schema: {type: object, properties: {title: {type: string}}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: notes}
spec: {surface: public, sql: 'SELECT id FROM notes ORDER BY id'}
`;
const purposes: MediaPurposePolicy[] = [
  { name: "cover", required: ["png"], maxBytes: { "image/png": 100 } },
  { name: "attachments", required: ["*/*"], maxBytes: { "*/*": 100 } },
  { name: "papers", required: ["application/pdf,text/*"], maxBytes: { "application/pdf": 100, "text/*": 50 } },
  { name: "archive", required: ["*/*"], maxBytes: { "*/*": 100 }, visibility: "private" },
];
const admin: any = fixtureCaller({
  kind: "user",
  subject: "admin-id",
  role: "admin",
  admin: true,
  scopes: ["mcp"],
  credential: "session",
  credentialId: null,
  clientId: null,
});

/**
 * An R2 bucket in memory that keeps each object's HTTP metadata and every URL it signs. Its signer signs headers as
 * aws4fetch does (Content-Type only with `allHeaders`), and `accepts` checks a PUT against the signature as S3 would.
 */
function bucket(publicBase: string | null, safeDelivery?: boolean) {
  const objects = new Map<
      string,
      { size: number; httpMetadata: { contentType: string; contentDisposition?: string } }
    >(),
    signed: string[] = [];
  const native: R2Bucket = {
    async head(key) {
      return objects.get(key) ?? null;
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { ...o, body: new Blob([new Uint8Array(o.size)]).stream() } : null;
    },
    async put(key, body, options) {
      objects.set(key, {
        size: (await new Response(body).arrayBuffer()).byteLength,
        httpMetadata: options.httpMetadata,
      });
    },
    async delete(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
    },
  };
  const endpoint = publicBase ? "https://public.r2.example.com" : "https://private.r2.example.com";
  const storage = r2MediaStorage({
    bucket: native,
    endpoint,
    publicBase,
    ...(safeDelivery === undefined ? {} : { safeDelivery }),
    signer: {
      async sign(url, init) {
        signed.push(url);
        const out = new URL(url),
          headers = init.aws.allHeaders ? Object.entries(init.headers ?? {}) : [];
        out.searchParams.set("X-Amz-SignedHeaders", ["host", ...headers.map(([name]) => name.toLowerCase())].join(";"));
        out.searchParams.set("X-Amz-Signature", encodeURIComponent(JSON.stringify(headers)));
        return { url: out.href };
      },
    },
  });
  /** Whether S3 would take a PUT to `url` with these headers: every signed header must carry its signed value. */
  const accepts = (url: string, headers: ConstructorParameters<typeof Headers>[0]) => {
    const signedHeaders: [string, string][] = JSON.parse(
      decodeURIComponent(new URL(url).searchParams.get("X-Amz-Signature")!),
    );
    return signedHeaders.every(([name, value]) => new Headers(headers).get(name) === value);
  };
  return { objects, signed, storage, endpoint, accepts };
}
type Bucket = ReturnType<typeof bucket>;

/** Create, PUT (as the upload URL would store it) and commit one single-variant upload. */
async function put(media: any, b: Bucket, purpose: string, filename: string, mimeType: string, size = 10) {
  const created = await media.createUpload({
    purpose,
    filename,
    variants: [{ mimeType, byteSize: size, role: "primary" }],
  });
  for (const c of created.capabilities)
    b.objects.set(new URL(c.uploadUrl).pathname.slice(1), { size, httpMetadata: { contentType: c.mimeType } });
  return media.commitUpload(created.uploadGroupId);
}
const refused = (media: any, purpose: string, mimeType: string, byteSize = 10) =>
  media.createUpload({ purpose, filename: "x", variants: [{ mimeType, byteSize, role: "primary" }] }).then(
    () => "accepted",
    (error: any) => error.code,
  );

async function scenario(site: (caller: unknown) => any) {
  const pub = bucket("https://media.example.com"),
    priv = bucket(null),
    media = site(admin).media({ public: pub.storage, private: priv.storage });
  const stored = (b: Bucket, asset: any) => b.objects.get(asset.variants[0].storageKey)!;

  // an image purpose behaves as before: inline, its own extension, SVG and other types refused
  const image = await put(media, pub, "cover", "photo.png", "image/png");
  expect(image.variants[0].storageKey).toEndWith("/primary.png");
  expect(stored(pub, image).httpMetadata).toEqual({ contentType: "image/png" });
  expect(await refused(media, "cover", "image/svg+xml")).toBe("MEDIA_VARIANTS_INCOMPLETE");
  expect(await refused(media, "cover", "application/pdf")).toBe("MEDIA_VARIANTS_INCOMPLETE");

  // */* takes a PDF, shown inline, keyed by its type's extension
  const pdf = await put(media, pub, "attachments", "report", "application/pdf");
  expect(pdf.variants[0]).toMatchObject({ mimeType: "application/pdf", byteSize: 10 });
  expect(pdf.variants[0].storageKey).toEndWith("/primary.pdf");
  expect(pdf.variants[0].publicUrl).toStartWith("https://media.example.com/committed/");
  expect(stored(pub, pdf).httpMetadata).toEqual({ contentType: "application/pdf" });

  // a type not shown inline is stored as an attachment named after the file, ASCII-safe and RFC 8187-encoded
  const zip = await put(media, pub, "attachments", "archive.zip", "application/zip");
  expect(zip.variants[0].storageKey).toEndWith("/primary.zip");
  expect(stored(pub, zip).httpMetadata).toEqual({
    contentType: "application/zip",
    contentDisposition: `attachment; filename="archive.zip"; filename*=UTF-8''archive.zip`,
  });
  const word = await put(
    media,
    pub,
    "attachments",
    'Résumé "final".DOCX',
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  expect(word.variants[0].storageKey).toEndWith("/primary.docx");
  expect(stored(pub, word).httpMetadata.contentDisposition).toBe(
    `attachment; filename="R_sum_ _final_.DOCX"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.DOCX`,
  );
  // an unknown type keeps a sanitized extension of the filename, never one a static host serves as a page
  for (const [filename, ending] of [
    ["data.Tar", "/primary.tar"],
    ["page.html", "/primary.bin"],
    ["script.mjs", "/primary.bin"],
    ["page.shtml", "/primary.bin"],
    ["page.PHTML", "/primary.bin"],
    ["saved.mhtml", "/primary.bin"],
    ["saved.mht", "/primary.bin"],
    ["index.php", "/primary.bin"],
    ["README", "/primary.bin"],
    ["odd.ex e", "/primary.bin"],
  ] as const)
    expect((await put(media, pub, "attachments", filename, "application/x-example")).variants[0].storageKey).toEndWith(
      ending,
    );

  // type/* slots and their caps: the exact type first, then type/*
  expect((await put(media, pub, "papers", "notes.txt", "text/plain", 40)).variants[0].storageKey).toEndWith(".txt");
  expect(await refused(media, "papers", "text/plain", 60)).toBe("MEDIA_VARIANT_SIZE_EXCEEDED");
  expect(await refused(media, "papers", "application/pdf", 60)).toBe("accepted");
  expect(await refused(media, "papers", "image/png")).toBe("MEDIA_VARIANTS_INCOMPLETE");

  // active content is refused by default; SVG keeps its own code
  expect(await refused(media, "attachments", "image/svg+xml")).toBe("MEDIA_SVG_REJECTED");
  for (const mimeType of [
    "text/html",
    "application/xhtml+xml",
    "text/xml",
    "application/xml",
    "application/rss+xml",
    "x-foo/bar+xml",
    "a1/b+xml",
    "model/xml",
    "text/javascript",
    "application/x-javascript",
    "multipart/x-mixed-replace",
  ])
    expect([mimeType, await refused(media, "attachments", mimeType)]).toEqual([
      mimeType,
      "MEDIA_ACTIVE_CONTENT_REJECTED",
    ]);
  expect(await refused(media, "papers", "text/html", 10)).toBe("MEDIA_ACTIVE_CONTENT_REJECTED");

  // the upload URL signs the declared type: a PUT with another Content-Type fails the signature
  const signedPut = await media.createUpload({
    purpose: "attachments",
    filename: "report.pdf",
    variants: [{ mimeType: "application/pdf", byteSize: 10, role: "primary" }],
  });
  const [capability] = signedPut.capabilities;
  expect(new URL(capability.uploadUrl).searchParams.get("X-Amz-SignedHeaders")).toBe("host;content-type");
  expect(pub.accepts(capability.uploadUrl, capability.requiredHeaders)).toBe(true);
  expect(pub.accepts(capability.uploadUrl, { "content-type": "text/html" })).toBe(false);
  expect(pub.accepts(capability.uploadUrl, {})).toBe(false);

  // a media type goes into signed headers: lowercase type/subtype, no parameters, bounded
  for (const mimeType of [
    "application/pdf; charset=binary",
    "Application/PDF",
    "application/pdf ",
    "application/pdf\r\nx-amz-acl: public-read",
    `application/${"x".repeat(128)}`,
    "*/*",
    "pdf",
  ])
    expect([mimeType, await refused(media, "attachments", mimeType)]).toEqual([mimeType, "MEDIA_MIME_REJECTED"]);
  expect(await refused(media, "attachments", `application/${"x".repeat(127)}`)).toBe("accepted");

  // private: a PDF reads inline; another type is signed to answer as an attachment, as it is stored
  const privatePdf = await put(media, priv, "archive", "scan.pdf", "application/pdf");
  expect(privatePdf.visibility).toBe("private");
  expect(privatePdf.variants[0].publicUrl).toBeUndefined();
  const [pdfRead] = (await media.signRead(privatePdf.id)).variants;
  expect(new URL(pdfRead.url).searchParams.has("response-content-disposition")).toBe(false);
  const csv = await put(media, priv, "archive", "ledger.csv", "text/csv");
  const disposition = `attachment; filename="ledger.csv"; filename*=UTF-8''ledger.csv`;
  expect(stored(priv, csv).httpMetadata).toEqual({ contentType: "text/csv", contentDisposition: disposition });
  const [csvRead] = (await media.signRead(csv.id)).variants;
  expect(new URL(csvRead.url).searchParams.get("response-content-disposition")).toBe(disposition);
  expect(csvRead.url).toStartWith(`${priv.endpoint}/committed/`);
  expect(await refused(media, "archive", "text/html")).toBe("MEDIA_ACTIVE_CONTENT_REJECTED");

  // a host whose media origin is isolated turns safe delivery off: active content is taken, nothing is an attachment
  const openPub = bucket("https://media.example.net", false),
    openPriv = bucket(null, false),
    open = site(admin).media({ public: openPub.storage, private: openPriv.storage });
  expect(openPub.storage.safeDelivery).toBe(false);
  expect(pub.storage.safeDelivery).toBe(true);
  const html = await put(open, openPub, "attachments", "page.html", "text/html");
  expect(html.variants[0].storageKey).toEndWith("/primary.bin");
  expect(stored(openPub, html).httpMetadata).toEqual({ contentType: "text/html" });
  const svg = await put(open, openPub, "attachments", "logo.svg", "image/svg+xml");
  expect(svg.variants[0].storageKey).toEndWith("/primary.svg");
  const openCsv = await put(open, openPriv, "archive", "ledger.csv", "text/csv");
  expect(stored(openPriv, openCsv).httpMetadata).toEqual({ contentType: "text/csv" });
  const [openRead] = (await open.signRead(openCsv.id)).variants;
  expect(new URL(openRead.url).searchParams.has("response-content-disposition")).toBe(false);
  // the strict type check stays on
  expect(await refused(open, "attachments", "text/html; charset=utf-8")).toBe("MEDIA_MIME_REJECTED");
}

async function generated(target: Target) {
  const result = await generateFromSources({
    target,
    sources: { sources: [{ sourceId: "notes.yaml", text: source }] },
    site: { media: { purposes } },
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  const dir = await mkdtemp(join(import.meta.dir, ".media-any-file-"));
  await writeGenerated(dir, result.files);
  return { dir, files: result.files, site: (await import(join(dir, "site.ts"))).site };
}

const PG = {
  "bun-postgres": process.env.MANTLE_NEXT_BUN_PG_URL,
  "cloudflare-postgres": process.env.MANTLE_NEXT_WORKER_PG_URL,
};
for (const target of ["bun-sqlite", "cloudflare-d1", "bun-postgres", "cloudflare-postgres"] as const) {
  const url = target in PG ? PG[target as keyof typeof PG] : "sqlite";
  (url ? test : test.skip)(
    `${target}: purposes take any file type; non-inline types are attachments and active content is refused unless safe delivery is off`,
    async () => {
      const { dir, files, site } = await generated(target);
      if (target === "bun-sqlite" || target === "cloudflare-d1") {
        const db = new Database(":memory:");
        try {
          db.exec(files["schema.sql"]!);
          const handle = target === "bun-sqlite" ? db : d1Shim(db);
          await scenario(caller => site(handle, caller));
        } finally {
          db.close();
          await rm(dir, { recursive: true, force: true });
        }
        return;
      }
      const sql: any =
          target === "bun-postgres" ? new SQL(url!, { max: 1 }) : postgres(url!, { max: 1, onnotice: () => {} }),
        schema = "media_any_" + crypto.randomUUID().replaceAll("-", "");
      try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        await sql.unsafe(files["schema.sql"]!);
        await scenario(caller => site(sql, caller));
      } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await sql.end?.();
        await sql.close?.();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
}

test("purpose types are strict at generation; wildcards need their own byte cap", async () => {
  const generate = (required: string[], maxBytes: Record<string, number>) =>
    generateFromSources({
      target: "bun-sqlite",
      sources: { sources: [{ sourceId: "notes.yaml", text: source }] },
      site: { media: { purposes: [{ name: "files", required, maxBytes }] } },
    });
  expect((await generate(["*/*"], { "*/*": 1 })).ok).toBe(true);
  expect((await generate(["video/*,application/pdf"], { "video/*": 1, "application/pdf": 1 })).ok).toBe(true);
  for (const token of ["application/pdf;q=1", "*/pdf", "video/**", "pdf/", `application/${"x".repeat(128)}`, "a b/c"]) {
    const result = await generate([token], { [token]: 1 });
    expect([token, result.ok]).toEqual([token, false]);
    expect(JSON.stringify(!result.ok && result.diagnostics)).toContain("lowercase type/subtype");
  }
  const missing = await generate(["*/*"], { "application/pdf": 1 });
  expect(JSON.stringify(!missing.ok && missing.diagnostics)).toContain("maxBytes is missing entries: */*");
  const overlap = await generate(["*/*", "*/*"], { "*/*": 1 });
  expect(JSON.stringify(!overlap.ok && overlap.diagnostics)).toContain("overlapping");
});

test("upload_media takes a PDF directly and from sourceUrl, for a public and a private purpose", async () => {
  const result = await generateFromSources({
    target: "bun-sqlite",
    sources: { sources: [{ sourceId: "notes.yaml", text: source }] },
    site: { media: { purposes } },
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  const dir = await mkdtemp(join(import.meta.dir, ".media-any-file-mcp-")),
    db = new Database(":memory:"),
    realFetch = globalThis.fetch,
    pub = bucket("https://media.example.com"),
    priv = bucket(null),
    accepts: string[] = [];
  const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const target = [pub, priv].find(b => url.origin === b.endpoint);
    if (target && init?.method === "PUT") {
      if (!target.accepts(url.href, init.headers ?? {})) return new Response(null, { status: 403 });
      target.objects.set(url.pathname.slice(1), {
        size: new Uint8Array(init.body as Uint8Array).byteLength,
        httpMetadata: { contentType: new Headers(init.headers).get("content-type")! },
      });
      return new Response(null, { status: 200 });
    }
    accepts.push(new Headers(init?.headers).get("accept")!);
    if (url.href === "https://files.example.com/report")
      return new Response(pdf, { headers: { "content-type": "Application/PDF; name=report" } });
    if (url.href === "https://files.example.com/page")
      return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
    if (url.href === "https://files.example.com/untyped") return new Response(pdf, { headers: { "content-type": "" } });
    if (url.href === "https://files.example.com/fake.png")
      return new Response("not a png", { headers: { "content-type": "image/png" } });
    throw Error("unexpected fetch " + url.href);
  }) as typeof fetch;
  try {
    db.exec(result.files["schema.sql"]!);
    await writeGenerated(dir, result.files);
    const { mcp } = await import(join(dir, "mcp.ts"));
    const handle = mcp({
      db: () => db,
      allowedOrigins: ["https://app.example.com"],
      caller: () => admin,
      media: () => ({ public: pub.storage, private: priv.storage }),
    });
    const call = async (args: object) => {
      const response = await handle(
        new Request(
          "https://app.example.com/mcp/admin",
          mcpInit(
            {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "upload_media", arguments: args },
            },
            {
              headers: {
                origin: "https://app.example.com",
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
            },
          ),
        ),
        {},
      );
      const text = await response.text();
      return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text).result;
    };
    const code = (out: any) => (out.isError ? JSON.parse(out.content[0].text).diagnostics[0].code : "accepted");
    for (const [purpose, b] of [
      ["attachments", pub],
      ["archive", priv],
    ] as const) {
      // direct: the agent PUTs to the target itself, then commits
      const prepared = (
        await call({
          purpose,
          filename: "report.pdf",
          variants: [{ mimeType: "application/pdf", byteSize: pdf.byteLength, role: "primary" }],
        })
      ).structuredContent;
      const [target] = prepared.targets;
      expect(target).toMatchObject({ mimeType: "application/pdf", headers: { "Content-Type": "application/pdf" } });
      // another Content-Type than the one signed is refused by the storage
      expect(
        (await fetch(target.url, { method: "PUT", headers: { "content-type": "text/html" }, body: pdf })).status,
      ).toBe(403);
      expect(code(await call({ uploadId: prepared.uploadId }))).toBe("MEDIA_OBJECT_NOT_FOUND");
      expect((await fetch(target.url, { method: "PUT", headers: target.headers, body: pdf })).status).toBe(200);
      const direct = (await call({ uploadId: prepared.uploadId })).structuredContent;
      expect(direct.variants).toMatchObject([{ mimeType: "application/pdf", byteSize: pdf.byteLength }]);
      expect(direct.variants[0].storageKey).toEndWith(".pdf");
      expect(direct.visibility).toBe(b === priv ? "private" : undefined);
      // sourceUrl: the response's Content-Type, without its parameters, types a file that is not an image
      const fetched = (await call({ purpose, sourceUrl: "https://files.example.com/report" })).structuredContent;
      expect(fetched.variants).toMatchObject([{ mimeType: "application/pdf", byteSize: pdf.byteLength }]);
      expect(fetched.variants[0].storageKey).toEndWith(".pdf");
      expect(b.objects.get(fetched.variants[0].storageKey)!.httpMetadata).toEqual({ contentType: "application/pdf" });
      expect(code(await call({ purpose, sourceUrl: "https://files.example.com/page" }))).toBe(
        "MEDIA_ACTIVE_CONTENT_REJECTED",
      );
      expect(code(await call({ purpose, sourceUrl: "https://files.example.com/untyped" }))).toBe("MEDIA_MIME_REJECTED");
    }
    expect(accepts.every(accept => accept === "*/*")).toBe(true);
    // an image purpose still asks for images and types them by their bytes: a header claiming PNG is not enough
    accepts.length = 0;
    expect(code(await call({ purpose: "cover", sourceUrl: "https://files.example.com/fake.png" }))).toBe(
      "MEDIA_MIME_REJECTED",
    );
    expect(code(await call({ purpose: "cover", sourceUrl: "https://files.example.com/report" }))).toBe(
      "MEDIA_MIME_REJECTED",
    );
    expect(accepts).toEqual(["image/*", "image/*"]);
  } finally {
    globalThis.fetch = realFetch;
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
