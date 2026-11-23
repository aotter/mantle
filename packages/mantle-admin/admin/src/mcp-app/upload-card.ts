/**
 * The upload card `mediaUploadCard` serves for `open_media_upload`: the person picks one file, the card calls `open_media_upload`
 * through the host, PUTs the file straight to storage with progress, calls `open_media_upload` again to commit, and tells the
 * model the asset id. It uploads the original as the single variant a purpose takes (ADR-0017); a purpose with several
 * variant slots needs an agent that prepares them.
 */
import { connectHost, type HostApi } from "./postmessage";
import { applyHostContext } from "../../../src/mcp-app.js";
import { uploadLabels, type UploadLabels } from "./locale";
import { ADMIN_LANGUAGES, normalizeLanguage } from "../app/languages";
import { forwardedInput } from "./forwarded-input";
import { diagnosticsOf, outputOf, type ToolResult } from "../../../src/app/bridge.js";

/** `@aotter/mantle/media`'s `UPLOAD_META`: the result `_meta` key with the upload targets. */
const UPLOAD_META = "net.aotter.mantle/upload";
/**
 * `mediaUploadCard`'s `tool`, `forward` and `inputTimeoutMs`, written into the page by the server (absent: `open_media_upload`,
 * nothing forwarded).
 */
const config = JSON.parse(document.getElementById("mantle-upload-config")?.textContent ?? "{}") as {
  tool?: string;
  forward?: string[];
  inputTimeoutMs?: number | false;
};
const TOOL = config.tool ?? "open_media_upload",
  forward = config.forward ?? [];
interface Purpose {
  readonly name: string;
  readonly required: readonly string[];
  readonly maxBytes: Readonly<Record<string, number>>;
}
interface Target {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

document.body.innerHTML = `<form id="card" aria-busy="true" novalidate>
<header><p class="eyebrow" data-upload-label="library"></p><h1 data-upload-label="title"></h1>
<p class="hint" data-upload-label="intro"></p></header>
<label id="purpose-row" hidden><span data-upload-label="purpose"></span> <select id="purpose"></select></label>
<div class="file-panel">
<label class="file-picker"><span class="file-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 17v-6m-3 3 3-3 3 3"/></svg></span>
<span class="picker-title" data-upload-label="choose"></span><span class="hint" data-upload-label="browse"></span>
<input id="file" type="file" required aria-label="File" aria-describedby="file-details policy"></label>
<p id="file-details" class="file-details">No file selected</p>
<p id="policy" class="hint"></p></div>
<label id="alt-row" hidden><span data-upload-label="alt"></span> <span class="hint" data-upload-label="altHint"></span><input id="alt" type="text" maxlength="1000" placeholder="Describe the image"></label>
<div class="actions"><button id="upload" type="button" disabled>Upload</button></div>
<progress id="progress" aria-label="Upload progress" max="1" value="0" hidden></progress>
<p id="status" role="status"></p>
<p class="footnote" data-upload-label="footnote"></p>
</form>`;
const form = $<HTMLFormElement>("card"),
  select = $<HTMLSelectElement>("purpose"),
  file = $<HTMLInputElement>("file");
const alt = $<HTMLInputElement>("alt"),
  button = $<HTMLButtonElement>("upload"),
  progress = $<HTMLProgressElement>("progress"),
  status = $<HTMLParagraphElement>("status");

// calls repeat the `forward` arguments of the rendering call's input; after the input arrives late, the purposes are read again
const forwarded = forwardedInput(forward, config.inputTimeoutMs ?? 5_000, () => readPurposes());
const bind =
  (call: NonNullable<HostApi["call"]>): NonNullable<HostApi["call"]> =>
  async (name, args, signal) =>
    call(name, await forwarded.args(args), signal);
let labels = uploadLabels(undefined);
const t = (key: keyof UploadLabels, values: Record<string, string | number> = {}) =>
  labels[key].replace(/\{(\w+)\}/g, (token, key: string) => String(values[key] ?? token));
class CardError extends Error {
  constructor(readonly text: () => string) {
    super(text());
  }
}
let pending: { uploadId: string; purpose: Purpose } | undefined;
let statusText: () => string = () => "";
let phase: "preparing" | "uploading" | "saving" = "preparing";
let host: HostApi | undefined,
  purposes: readonly Purpose[] = [],
  asked: string | undefined,
  busy = false,
  failed = false,
  done = false;
const say = (text: string | (() => string), alert = false) => {
  statusText = typeof text === "string" ? () => text : text;
  status.textContent = statusText();
  status.setAttribute("role", alert ? "alert" : "status");
};
/** The diagnostic message of a failed call, else `fallback`. */
const failure = (result: ToolResult, fallback: keyof UploadLabels) => {
  const message = diagnosticsOf(result)[0]?.message;
  return new CardError(typeof message === "string" ? () => message : () => t(fallback));
};
const current = () => purposes.find(p => p.name === (asked ?? select.value));
/** The token of `accepts` that takes `type`: the type itself, else its `type/*`, else `*\/*`. */
const acceptedBy = (accepts: readonly string[], type: string) =>
  [type, type.replace(/\/.*/, "/*"), "*/*"].find(token => accepts.includes(token));
/** A file the browser cannot type is sent as bytes. */
const typeOf = (picked: File) => picked.type || "application/octet-stream";
const sizeOf = (bytes: number) =>
  bytes < 1024
    ? t("bytes", { count: bytes })
    : `${(bytes / (bytes < 1048576 ? 1024 : 1048576)).toFixed(1)} ${bytes < 1048576 ? "KiB" : "MiB"}`;

function render() {
  for (const element of document.querySelectorAll<HTMLElement>("[data-upload-label]"))
    element.textContent = t(element.dataset.uploadLabel as keyof UploadLabels);
  file.setAttribute("aria-label", t("file"));
  alt.placeholder = t("altPlaceholder");
  progress.setAttribute("aria-label", t("progress"));
  document.title = t("title");
  const names = purposes.map(p => p.name),
    selected = asked ?? select.value;
  select.replaceChildren(...names.map(name => new Option(name, name)));
  if (names.includes(selected)) select.value = selected;
  $("purpose-row").hidden = !!asked || names.length < 2;
  const purpose = pending?.purpose ?? current();
  // `*/*` is no `accept` token: an empty one offers every file
  const accepts = purpose?.required.length === 1 ? purpose.required[0]!.split(",") : [];
  file.accept = accepts.includes("*/*") ? "" : accepts.join(",");
  // alt text describes an image
  $("alt-row").hidden = !file.files?.[0]?.type.startsWith("image/");
  const picked = file.files?.[0];
  $("file-details").textContent = picked ? `${picked.name} · ${sizeOf(picked.size)} · ${typeOf(picked)}` : t("noFile");
  $("file-details").hidden = !picked;
  const token = picked && acceptedBy(accepts, typeOf(picked));
  $("policy").textContent = !purpose
    ? ""
    : purpose.required.length !== 1
      ? t("multiVariants")
      : token
        ? t("upTo", { size: sizeOf(purpose.maxBytes[token] ?? 0) })
        : accepts.includes("*/*")
          ? `${t("anyFile")} · ${t("upTo", { size: sizeOf(purpose.maxBytes["*/*"] ?? 0) })}`
          : accepts
              .map(type =>
                t("typeLimit", {
                  type:
                    type === "image/*" ? t("anyImage") : type.startsWith("image/") ? type.slice(6).toUpperCase() : type,
                  size: sizeOf(purpose.maxBytes[type] ?? 0),
                }),
              )
              .join(" · ");
  file.disabled = select.disabled = alt.disabled = busy || done || pending !== undefined;
  button.disabled = busy || done || !picked || !host?.call || !purpose;
  button.textContent = done ? t("uploaded") : busy ? t(phase) : failed ? t("retry") : t("upload");
  form.setAttribute("aria-busy", String(busy || !host || !purposes.length));
  if (!host) say(() => t("connecting"));
  else if (asked && purposes.length && !purpose) say(() => t("unknownPurpose", { purpose: asked! }), true);
  else if (!host.call) say(() => t("toolsUnavailable"), true);
  status.textContent = statusText();
}

/** The upload is committed: report the asset and offer no second upload of it. */
function finish(id: string) {
  done = true;
  progress.hidden = true;
  file.disabled = true;
  alt.disabled = true;
  form.dataset.asset = id;
  say(() => t("complete", { id }));
}
/** PUT with upload progress: `fetch` reports none. */
const put = (target: Target, body: File) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) progress.value = event.loaded / event.total;
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new CardError(() => t("storageFailed", { status: xhr.status })));
    xhr.onerror = () => reject(new CardError(() => t("storageUnavailable")));
    xhr.send(body);
  });

async function upload(picked: File, purpose: Purpose, call: NonNullable<HostApi["call"]>) {
  const accepts = purpose.required.length === 1 ? purpose.required[0]!.split(",") : [];
  if (!accepts.length)
    throw new CardError(() =>
      t("variantsNeeded", {
        purpose: purpose.name,
        count: purpose.required.length,
        types: purpose.required.join("; "),
      }),
    );
  const type = typeOf(picked),
    token = acceptedBy(accepts, type);
  if (!token)
    throw new CardError(() => t("mimeRejected", { purpose: purpose.name, types: accepts.join(t("or")), type }));
  const cap = purpose.maxBytes[token] ?? 0;
  if (picked.size > cap)
    throw new CardError(() => t("tooLarge", { size: picked.size, purpose: purpose.name, max: cap }));
  const text = type.startsWith("image/") ? alt.value.trim() : "";
  const created = await call(TOOL, {
    purpose: purpose.name,
    filename: picked.name.slice(0, 255) || "upload",
    variants: [{ mimeType: type, byteSize: picked.size, role: "primary" }],
    ...(text ? { alt: text } : {}),
  });
  if (created.isError) throw failure(created, "prepareFailed");
  const out = outputOf(created),
    meta = (created as { _meta?: Record<string, unknown> })._meta?.[UPLOAD_META];
  const targets = (record(meta) ? meta.targets : record(out) ? out.targets : undefined) as Target[] | undefined;
  const uploadId = record(out) ? out.uploadId : undefined;
  if (typeof uploadId !== "string" || !Array.isArray(targets) || targets.length !== 1)
    throw new CardError(() => t("targetMissing"));
  phase = "uploading";
  say(() => t("uploadingFile", { filename: picked.name }));
  render();
  progress.hidden = false;
  progress.value = 0;
  await put(targets[0]!, picked);
  pending = { uploadId, purpose };
  return commit(call, pending);
}

async function commit(call: NonNullable<HostApi["call"]>, upload: NonNullable<typeof pending>) {
  phase = "saving";
  say(() => t("committing"));
  render();
  const committed = await call(TOOL, { uploadId: upload.uploadId, purpose: upload.purpose.name });
  const asset = outputOf(committed);
  if (committed.isError) {
    const code = diagnosticsOf(committed)[0]?.code;
    // An unknown outcome can already have produced the asset. Ask the server again with the same ID.
    if (
      code === "MEDIA_UPLOAD_EXPIRED" ||
      code === "MEDIA_OBJECT_NOT_FOUND" ||
      code === "MEDIA_MIME_REJECTED" ||
      code === "MEDIA_VARIANT_SIZE_EXCEEDED"
    )
      pending = undefined;
    throw failure(committed, "commitFailed");
  }
  if (!record(asset) || typeof asset.id !== "string") throw failure(committed, "commitFailed");
  pending = undefined;
  return asset as Record<string, unknown> & { id: string };
}

// a click, not a form submission: a sandbox without allow-forms never dispatches submit
button.addEventListener("click", () => {
  const picked = file.files?.[0],
    purpose = pending?.purpose ?? current(),
    call = host?.call && bind(host.call);
  if (!picked || !purpose || !call || busy || done) return;
  busy = true;
  phase = "preparing";
  say(() => t("preparing"));
  render();
  void (pending ? commit(call, pending) : upload(picked, purpose, call))
    .then(
      async asset => {
        const text = t("completionMessage", { filename: picked.name, id: asset.id, purpose: purpose.name });
        finish(asset.id);
        // a user message continues the conversation; unless the host accepted it, the model also learns it at its next turn
        if ((await host!.sendMessage(text)) !== "accepted")
          await host!.updateModelContext({ content: [{ type: "text", text }], structuredContent: { asset } });
      },
      (error: unknown) => {
        failed = true;
        progress.hidden = true;
        say(error instanceof CardError ? error.text : error instanceof Error ? error.message : String(error), true);
      },
    )
    .finally(() => {
      busy = false;
      render();
    });
});
select.addEventListener("change", render);
file.addEventListener("change", () => {
  failed = false;
  say("");
  render();
});

/** The policy, from the server: it is the authority on purposes, types and caps. Only the latest read applies. */
let reads = 0;
function readPurposes() {
  if (!host?.call) return;
  const read = ++reads;
  void bind(host.call)(TOOL, {}).then(
    result => {
      if (read !== reads) return;
      const out = outputOf(result);
      if (!result.isError && record(out) && Array.isArray(out.purposes)) {
        purposes = out.purposes as Purpose[];
        say("");
      } else say(failure(result, "policyFailed").text, true);
      render();
    },
    () => {
      if (read === reads) say(() => t("policyFailed"), true);
    },
  );
}

const preferredDark = window.matchMedia("(prefers-color-scheme: dark)");
let hasHostTheme = false;
function followSystemTheme() {
  if (!hasHostTheme) applyHostContext({ theme: preferredDark.matches ? "dark" : "light" });
}
preferredDark.addEventListener("change", followSystemTheme);
followSystemTheme();

function context(value: Parameters<typeof applyHostContext>[0]) {
  if (value.locale !== undefined) {
    labels = uploadLabels(value.locale);
    const language = normalizeLanguage(value.locale);
    document.documentElement.dir = ADMIN_LANGUAGES.find(item => item.value === language)?.direction ?? "ltr";
  }
  if (value.theme !== undefined) hasHostTheme = true;
  applyHostContext(value);
  render();
}

connectHost(
  {
    ready: (connected, initial) => {
      host = connected;
      forwarded.connected();
      context(initial);
      readPurposes();
    },
    input: args => {
      forwarded.input(args);
      if (typeof args.purpose === "string") {
        asked = args.purpose;
        render();
      }
    },
    // a call that already committed (by uploadId, sourceUrl or file) renders as its asset, not as a new form
    result: result => {
      const out = outputOf(result);
      if (!result.isError && record(out) && typeof out.id === "string" && Array.isArray(out.variants)) {
        finish(out.id);
        render();
      }
    },
    cancelled: () => {},
    context,
    error: error => say(() => `${t("connectionFailed")} ${error.message}`, true),
  },
  window,
  "1",
  // the card shows no View, so the App's view_* tools would only ever answer that none is shown
  { appTools: false },
);
render();
