/**
 * The upload card `mediaUploadCard` serves for `upload_media`: the person picks one image, the card calls `upload_media`
 * through the host, PUTs the file straight to storage with progress, calls `upload_media` again to commit, and tells the
 * model the asset id. It uploads the original as the single variant a purpose takes (ADR-0017); a purpose with several
 * variant slots needs an agent that prepares them.
 * ponytail: English only; take the host context's locale when hosts ask for another.
 */
import { applyHostContext, connectHost, type HostApi } from "./postmessage";
import { outputOf, type ToolResult } from "../../../src/app/bridge.js";

/** `@aotter/mantle/media`'s `UPLOAD_META`: the result `_meta` key with the upload targets. */
const UPLOAD_META = "net.aotter.mantle/upload";
/**
 * `mediaUploadCard`'s `tool`, `forward` and `inputTimeoutMs`, written into the page by the server (absent: `upload_media`,
 * nothing forwarded).
 */
const config = JSON.parse(document.getElementById("mantle-upload-config")?.textContent ?? "{}") as {
  tool?: string;
  forward?: string[];
  inputTimeoutMs?: number;
};
const TOOL = config.tool ?? "upload_media",
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
<h1>Upload an image</h1>
<label id="purpose-row" hidden>Purpose <select id="purpose"></select></label>
<label>Image <input id="file" type="file" required></label>
<label>Alt text <input id="alt" type="text" maxlength="1000" placeholder="Describe the image"></label>
<button id="upload" type="button" disabled>Upload</button>
<progress id="progress" max="1" value="0" hidden></progress>
<p id="status" role="status"></p>
</form>`;
const form = $<HTMLFormElement>("card"),
  select = $<HTMLSelectElement>("purpose"),
  file = $<HTMLInputElement>("file");
const alt = $<HTMLInputElement>("alt"),
  button = $<HTMLButtonElement>("upload"),
  progress = $<HTMLProgressElement>("progress"),
  status = $<HTMLParagraphElement>("status");

// the forwarded arguments come from the rendering call's input, so every call waits for it when there are any; a host
// that never sends it does not leave the card waiting: after `inputTimeoutMs` from connecting, calls go without them and
// the server's refusal (or answer) shows as for any call
const bound: Record<string, unknown> = {};
let inputArrived!: () => void;
const input = forward.length
  ? new Promise<void>(resolve => {
      inputArrived = resolve;
    })
  : Promise.resolve();
const bind =
  (call: NonNullable<HostApi["call"]>): NonNullable<HostApi["call"]> =>
  async (name, args, signal) => {
    await input;
    return call(name, { ...args, ...bound }, signal);
  };
let host: HostApi | undefined,
  purposes: readonly Purpose[] = [],
  asked: string | undefined,
  busy = false,
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

function render() {
  const names = purposes.map(p => p.name);
  select.replaceChildren(...names.map(name => new Option(name, name)));
  if (asked && names.includes(asked)) select.value = asked;
  $("purpose-row").hidden = !!asked || names.length < 2;
  const purpose = current();
  file.accept = purpose?.required.length === 1 ? purpose.required[0]! : "image/*";
  button.disabled = busy || done || !host?.call || !purpose;
  form.setAttribute("aria-busy", String(busy || !host));
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
  if (!accepts.includes(picked.type))
    throw new Error(`'${purpose.name}' takes ${accepts.join(" or ")}, not ${picked.type || "this file"}.`);
  const cap = purpose.maxBytes[picked.type] ?? 0;
  if (picked.size > cap) throw new Error(`The image is ${picked.size} bytes; '${purpose.name}' takes at most ${cap}.`);
  const text = alt.value.trim();
  const created = await call(TOOL, {
    purpose: purpose.name,
    filename: picked.name.slice(0, 255) || "upload",
    variants: [{ mimeType: picked.type, byteSize: picked.size, role: "primary" }],
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

connectHost(
  {
    ready: (connected, context) => {
      host = connected;
      if (forward.length) setTimeout(inputArrived, config.inputTimeoutMs ?? 5_000);
      applyHostContext(context);
      render();
      // the policy, from the server: it is the authority on purposes, types and caps
      if (connected.call)
        void bind(connected.call)(TOOL, {}).then(
          result => {
            const out = outputOf(result);
            if (!result.isError && record(out) && Array.isArray(out.purposes)) {
              purposes = out.purposes as Purpose[];
              say("");
            } else say(failure(result, "The media purposes could not be read."), true);
            render();
          },
          () => {
            say("The media purposes could not be read.", true);
          },
        );
    },
    input: args => {
      for (const name of forward) if (args[name] !== undefined) bound[name] = args[name];
      inputArrived?.();
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
