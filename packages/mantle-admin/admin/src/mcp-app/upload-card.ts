/**
 * The upload card `mediaUploadCard` serves for `open_media_upload`: the person picks one file, the card calls `open_media_upload`
 * through the host, PUTs the file straight to storage with progress, calls `open_media_upload` again to commit, and tells the
 * model the asset id. It uploads the original as the single variant a purpose takes (ADR-0017); a purpose with several
 * variant slots needs an agent that prepares them.
 * ponytail: English only; take the host context's locale when hosts ask for another.
 */
import { applyHostContext, connectHost, type HostApi } from "./postmessage";
import { forwardedInput } from "./forwarded-input";
import { outputOf, type ToolResult } from "../../../src/app/bridge.js";

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
<header><span class="upload-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg></span>
<div><p class="eyebrow">Media library</p><h1>Upload a file</h1></div></header>
<p class="hint">Add the original file to your media library.</p>
<label id="purpose-row" hidden>Purpose <select id="purpose"></select></label>
<div class="file-panel">
<label class="file-picker">File <input id="file" type="file" required aria-describedby="file-details policy"></label>
<p id="file-details" class="file-details">No file selected</p>
<p id="policy" class="hint"></p></div>
<label id="alt-row" hidden>Alt text <span class="hint">A short description for people who cannot see the image.</span><input id="alt" type="text" maxlength="1000" placeholder="Describe the image"></label>
<button id="upload" type="button" disabled>Upload</button>
<progress id="progress" aria-label="Upload progress" max="1" value="0" hidden></progress>
<p id="status" role="status"></p>
<p class="footnote">Keep this card open until the upload finishes.</p>
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
let host: HostApi | undefined,
  purposes: readonly Purpose[] = [],
  asked: string | undefined,
  busy = false,
  failed = false,
  done = false;
const say = (text: string, alert = false) => {
  status.textContent = text;
  status.setAttribute("role", alert ? "alert" : "status");
};
/** The diagnostic message of a failed call, else `fallback`. */
const failure = (result: ToolResult, fallback: string) => {
  const out = outputOf(result),
    diagnostic =
      record(out) && Array.isArray(out.diagnostics) && record(out.diagnostics[0]) ? out.diagnostics[0] : undefined;
  return typeof diagnostic?.message === "string" ? diagnostic.message : fallback;
};
const current = () => purposes.find(p => p.name === (asked ?? select.value));
/** The token of `accepts` that takes `type`: the type itself, else its `type/*`, else `*\/*`. */
const acceptedBy = (accepts: readonly string[], type: string) =>
  [type, type.replace(/\/.*/, "/*"), "*/*"].find(token => accepts.includes(token));
/** A file the browser cannot type is sent as bytes. */
const typeOf = (picked: File) => picked.type || "application/octet-stream";
const sizeOf = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : `${(bytes / (bytes < 1048576 ? 1024 : 1048576)).toFixed(1)} ${bytes < 1048576 ? "KiB" : "MiB"}`;

function render() {
  const names = purposes.map(p => p.name),
    selected = asked ?? select.value;
  select.replaceChildren(...names.map(name => new Option(name, name)));
  if (names.includes(selected)) select.value = selected;
  $("purpose-row").hidden = !!asked || names.length < 2;
  const purpose = current();
  // `*/*` is no `accept` token: an empty one offers every file
  const accepts = purpose?.required.length === 1 ? purpose.required[0]!.split(",") : [];
  file.accept = accepts.includes("*/*") ? "" : accepts.join(",");
  // alt text describes an image
  $("alt-row").hidden = !file.files?.[0]?.type.startsWith("image/");
  const picked = file.files?.[0];
  $("file-details").textContent = picked
    ? `${picked.name} · ${sizeOf(picked.size)} · ${typeOf(picked)}`
    : "No file selected";
  $("file-details").hidden = !picked;
  const token = picked && acceptedBy(accepts, typeOf(picked));
  $("policy").textContent = !purpose
    ? ""
    : purpose.required.length !== 1
      ? "This purpose needs several variants. Ask the agent to prepare them."
      : token
        ? `${typeOf(picked!)} · Up to ${sizeOf(purpose.maxBytes[token] ?? 0)}`
        : accepts.includes("*/*")
          ? `Any file type · Up to ${sizeOf(purpose.maxBytes["*/*"] ?? 0)}`
          : accepts
              .map(
                type =>
                  `${type === "image/*" ? "Any image" : type.startsWith("image/") ? type.slice(6).toUpperCase() : type} up to ${sizeOf(purpose.maxBytes[type] ?? 0)}`,
              )
              .join(" · ");
  file.disabled = select.disabled = alt.disabled = busy || done;
  button.disabled = busy || done || !picked || !host?.call || !purpose;
  button.textContent = done ? "Uploaded" : busy ? "Uploading…" : failed ? "Try again" : "Upload";
  form.setAttribute("aria-busy", String(busy || !host || !purposes.length));
  if (!host) say("Connecting to the MCP host…");
  else if (asked && purposes.length && !purpose) say(`The purpose '${asked}' is not declared.`, true);
  else if (!host.call) say("This host does not let the card call tools.", true);
}

/** The upload is committed: report the asset and offer no second upload of it. */
function finish(id: string) {
  done = true;
  progress.hidden = true;
  file.disabled = true;
  alt.disabled = true;
  form.dataset.asset = id;
  say(`Uploaded. Asset id ${id}.`);
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
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage answered ${xhr.status}.`));
    xhr.onerror = () =>
      reject(new Error("Storage could not be reached. Its CORS rules must allow PUT from this host."));
    xhr.send(body);
  });

async function upload(picked: File, purpose: Purpose, call: NonNullable<HostApi["call"]>) {
  const accepts = purpose.required.length === 1 ? purpose.required[0]!.split(",") : [];
  if (!accepts.length)
    throw new Error(
      `'${purpose.name}' takes ${purpose.required.length} variants (${purpose.required.join("; ")}); ask the agent to prepare and upload them.`,
    );
  const type = typeOf(picked),
    token = acceptedBy(accepts, type);
  if (!token) throw new Error(`'${purpose.name}' takes ${accepts.join(" or ")}, not ${type}.`);
  const cap = purpose.maxBytes[token] ?? 0;
  if (picked.size > cap) throw new Error(`The file is ${picked.size} bytes; '${purpose.name}' takes at most ${cap}.`);
  const text = type.startsWith("image/") ? alt.value.trim() : "";
  const created = await call(TOOL, {
    purpose: purpose.name,
    filename: picked.name.slice(0, 255) || "upload",
    variants: [{ mimeType: type, byteSize: picked.size, role: "primary" }],
    ...(text ? { alt: text } : {}),
  });
  if (created.isError) throw new Error(failure(created, "The upload could not be prepared."));
  const out = outputOf(created),
    meta = (created as { _meta?: Record<string, unknown> })._meta?.[UPLOAD_META];
  const targets = (record(meta) ? meta.targets : record(out) ? out.targets : undefined) as Target[] | undefined;
  const uploadId = record(out) ? out.uploadId : undefined;
  if (typeof uploadId !== "string" || !Array.isArray(targets) || targets.length !== 1)
    throw new Error("The server answered without an upload target.");
  say(`Uploading ${picked.name}…`);
  progress.hidden = false;
  progress.value = 0;
  await put(targets[0]!, picked);
  say("Committing…");
  button.textContent = "Saving…";
  const committed = await call(TOOL, { uploadId, purpose: purpose.name });
  const asset = outputOf(committed);
  if (committed.isError || !record(asset) || typeof asset.id !== "string")
    throw new Error(failure(committed, "The upload could not be committed."));
  return asset as Record<string, unknown> & { id: string };
}

// a click, not a form submission: a sandbox without allow-forms never dispatches submit
button.addEventListener("click", () => {
  const picked = file.files?.[0],
    purpose = current(),
    call = host?.call && bind(host.call);
  if (!picked || !purpose || !call || busy || done) return;
  busy = true;
  render();
  void upload(picked, purpose, call)
    .then(
      async asset => {
        const text = `I uploaded ${picked.name} to the media library: asset id ${asset.id} (purpose ${purpose.name}).`;
        finish(asset.id);
        // a user message continues the conversation; unless the host accepted it, the model also learns it at its next turn
        if ((await host!.sendMessage(text)) !== "accepted")
          await host!.updateModelContext({ content: [{ type: "text", text }], structuredContent: { asset } });
      },
      (error: unknown) => {
        failed = true;
        progress.hidden = true;
        say(error instanceof Error ? error.message : String(error), true);
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
      } else say(failure(result, "The media purposes could not be read."), true);
      render();
    },
    () => {
      if (read === reads) say("The media purposes could not be read.", true);
    },
  );
}

connectHost(
  {
    ready: (connected, context) => {
      host = connected;
      forwarded.connected();
      applyHostContext(context);
      render();
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
    context: applyHostContext,
    error: error => say(error.message, true),
  },
  window,
  "1",
  // the card shows no View, so the App's view_* tools would only ever answer that none is shown
  { appTools: false },
);
render();
