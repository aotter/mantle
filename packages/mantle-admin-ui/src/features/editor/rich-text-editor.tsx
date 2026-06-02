import * as React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Check,
  Code2,
  ExternalLink,
  Highlighter,
  ImageIcon,
  Images,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Palette,
  Redo2,
  Strikethrough,
  Table2,
  Type,
  Underline,
  Undo2,
  Upload,
  Video,
  Wand2,
  X,
} from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { Button } from "../../ui/button";
import { MEDIA_ASSETS } from "../media/media-assets";

export type EditorMode = "markdown" | "html" | "rich";

type MediaUploadResponse = {
  uploadGroupId: string;
  capabilities: Array<{
    mimeType: string;
    role: "primary" | "alternate" | "fallback";
    method: "PUT";
    uploadUrl: string;
    requiredHeaders?: Record<string, string>;
  }>;
};

type CommittedMediaAsset = {
  id: string;
  alt?: string;
  variants: Array<{
    mimeType: string;
    publicUrl: string;
    role: "primary" | "alternate" | "fallback";
  }>;
};

export function RichTextEditor({
  value,
  onChange,
  label,
  mode,
  onModeChange,
  compact = false,
  showPreview = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  mode?: EditorMode;
  onModeChange?: (mode: EditorMode) => void;
  compact?: boolean;
  showPreview?: boolean;
}): React.ReactElement {
  const { language } = usePreferences();
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [mediaOpen, setMediaOpen] = React.useState(false);
  const [videoOpen, setVideoOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const activeMode = mode ?? "rich";

  const insert = React.useCallback(
    (before: string, after = "", placeholder = "") => {
      const input = textRef.current;
      if (!input) {
        onChange(`${value}${before}${placeholder}${after}`);
        return;
      }
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const selected = value.slice(start, end) || placeholder;
      const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
      onChange(next);
      window.requestAnimationFrame(() => {
        input.focus();
        const cursorStart = start + before.length;
        const cursorEnd = cursorStart + selected.length;
        input.setSelectionRange(cursorStart, cursorEnd);
      });
    },
    [onChange, value],
  );

  const insertBlock = React.useCallback(
    (block: string) => {
      const prefix = value.endsWith("\n") || value.length === 0 ? "" : "\n\n";
      insert(`${prefix}${block}`, "", "");
    },
    [insert, value],
  );

  function applyTextStyle(style: string): void {
    if (style === "paragraph") return;
    if (/^h[1-6]$/.test(style)) {
      const level = Number(style.slice(1));
      insert(`${"#".repeat(level)} `, "", t(language, "editor.headingPlaceholder"));
      return;
    }
    if (style === "quote") insertBlock("> ");
    if (style === "code") insert("```\n", "\n```", "code");
  }

  async function uploadImage(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    try {
      const created = await api.post<MediaUploadResponse>("/media/uploads", {
        filename: file.name,
        purpose: "content",
        variants: [{ mimeType: file.type || "application/octet-stream", byteSize: file.size, role: "primary" }],
        alt: file.name.replace(/\.[^.]+$/, ""),
      });
      const primary = created.capabilities.find((cap) => cap.role === "primary") ?? created.capabilities[0];
      if (!primary) throw new Error("Upload capability missing.");
      await fetch(primary.uploadUrl, {
        method: primary.method,
        headers: primary.requiredHeaders ?? { "Content-Type": file.type },
        body: file,
      });
      const committed = await api.post<CommittedMediaAsset>(
        `/media/uploads/${encodeURIComponent(created.uploadGroupId)}/commit`,
        { alt: file.name.replace(/\.[^.]+$/, "") },
      );
      const variant = committed.variants.find((v) => v.role === "primary") ?? committed.variants[0];
      if (!variant) throw new Error("Uploaded media has no public URL.");
      insertImage(variant.publicUrl, committed.alt ?? file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function insertImage(url: string, alt: string): void {
    insertBlock(`![${alt || "image"}](${url})`);
  }

  function insertVideo(url: string): void {
    const embed = videoEmbed(url);
    insertBlock(embed);
    setVideoOpen(false);
  }

  return (
    <div className="rich-editor">
      <div className="rich-editor-topline">
        {label ? <span className="text-sm font-semibold">{label}</span> : null}
        {onModeChange ? (
          <div className="segmented-control rich-editor-modes">
            {(["rich", "markdown", "html"] as const).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                data-active={activeMode === nextMode}
                onClick={() => onModeChange(nextMode)}
              >
                {editorModeLabel(language, nextMode)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="rich-editor-toolbar" aria-label={t(language, "editor.toolbar")}>
        <ToolbarButton title={t(language, "editor.undo")} onClick={() => runTextCommand("undo", textRef.current)}>
          <Undo2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.redo")} onClick={() => runTextCommand("redo", textRef.current)}>
          <Redo2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.aiClean")} onClick={() => insertBlock("> 重點提示：")}>
          <Wand2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.uploadImage")} onClick={() => fileRef.current?.click()} disabled={uploading}>
          <Upload className="size-4" aria-hidden />
        </ToolbarButton>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void uploadImage(file);
          }}
        />
        <ToolbarDivider />
        <label className="rich-editor-select" title={t(language, "editor.textStyle")}>
          <Type className="size-4" aria-hidden />
          <select
            onChange={(event) => {
              applyTextStyle(event.target.value);
              event.target.value = "paragraph";
            }}
            defaultValue="paragraph"
          >
            <option value="paragraph">{t(language, "editor.paragraph")}</option>
            <option value="h1">{t(language, "editor.heading1")}</option>
            <option value="h2">{t(language, "editor.heading2")}</option>
            <option value="h3">{t(language, "editor.heading3")}</option>
            <option value="h4">{t(language, "editor.heading4")}</option>
            <option value="h5">{t(language, "editor.heading5")}</option>
            <option value="h6">{t(language, "editor.heading6")}</option>
            <option value="quote">{t(language, "editor.quote")}</option>
            <option value="code">{t(language, "editor.codeBlock")}</option>
          </select>
        </label>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.bold")} onClick={() => insert("**", "**", t(language, "editor.selectedText"))}>
          <Bold className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.italic")} onClick={() => insert("_", "_", t(language, "editor.selectedText"))}>
          <Italic className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.underline")} onClick={() => insert("<u>", "</u>", t(language, "editor.selectedText"))}>
          <Underline className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.strike")} onClick={() => insert("~~", "~~", t(language, "editor.selectedText"))}>
          <Strikethrough className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.inlineCode")} onClick={() => insert("`", "`", "code")}>
          <Code2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.textColor")} onClick={() => insert('<span class="text-accent">', "</span>", t(language, "editor.selectedText"))}>
          <Baseline className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.highlight")} onClick={() => insert("<mark>", "</mark>", t(language, "editor.selectedText"))}>
          <Highlighter className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.palette")} onClick={() => insert('<span class="brand-tone">', "</span>", t(language, "editor.selectedText"))}>
          <Palette className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.alignLeft")} onClick={() => insertBlock('<p style="text-align:left"></p>')}>
          <AlignLeft className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.alignCenter")} onClick={() => insertBlock('<p style="text-align:center"></p>')}>
          <AlignCenter className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.alignRight")} onClick={() => insertBlock('<p style="text-align:right"></p>')}>
          <AlignRight className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.bulletList")} onClick={() => insertBlock("- ")}>
          <List className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.numberList")} onClick={() => insertBlock("1. ")}>
          <ListOrdered className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.checkList")} onClick={() => insertBlock("- [ ] ")}>
          <ListChecks className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.indent")} onClick={() => insert("  ", "", "")}>
          <IndentIncrease className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.link")} onClick={() => insert("[", "](https://)", t(language, "editor.linkText"))}>
          <Link className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.table")} onClick={() => insertBlock("| 欄位 | 說明 |\n| --- | --- |\n|  |  |")}>
          <Table2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.mediaLibrary")} onClick={() => setMediaOpen(true)}>
          <Images className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.imageUrl")} onClick={() => setMediaOpen(true)}>
          <ImageIcon className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.videoUrl")} onClick={() => setVideoOpen(true)}>
          <Video className="size-4" aria-hidden />
        </ToolbarButton>
      </div>

      <textarea
        ref={textRef}
        className={compact ? "admin-textarea admin-textarea-compact rich-editor-textarea" : "admin-textarea rich-editor-textarea"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {uploading ? <p className="text-xs text-muted-foreground">{t(language, "editor.uploading")}</p> : null}
      {showPreview ? (
        <div className="editor-preview" dangerouslySetInnerHTML={{ __html: renderRichTextPreview(value, activeMode) }} />
      ) : null}

      {mediaOpen ? (
        <MediaInsertDialog
          language={language}
          onClose={() => setMediaOpen(false)}
          onInsert={(url, alt) => {
            insertImage(url, alt);
            setMediaOpen(false);
          }}
        />
      ) : null}
      {videoOpen ? (
        <VideoInsertDialog
          language={language}
          onClose={() => setVideoOpen(false)}
          onInsert={insertVideo}
        />
      ) : null}
    </div>
  );
}

function ToolbarButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function editorModeLabel(language: AdminLanguage, mode: EditorMode): string {
  if (mode === "html") return t(language, "editor.mode.html");
  if (mode === "markdown") return t(language, "editor.mode.markdown");
  return t(language, "editor.mode.rich");
}

function ToolbarDivider(): React.ReactElement {
  return <span className="rich-editor-divider" aria-hidden />;
}

function MediaInsertDialog({
  language,
  onClose,
  onInsert,
}: {
  language: AdminLanguage;
  onClose: () => void;
  onInsert: (url: string, alt: string) => void;
}): React.ReactElement {
  const [url, setUrl] = React.useState("");
  const [alt, setAlt] = React.useState("");
  return (
    <div className="rich-editor-dialog-backdrop" role="presentation">
      <div className="rich-editor-dialog" role="dialog" aria-modal="true" aria-label={t(language, "editor.mediaLibrary")}>
        <DialogHeader title={t(language, "editor.insertImage")} onClose={onClose} />
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm font-medium">
            {t(language, "editor.imageUrl")}
            <input className="admin-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            {t(language, "media.alt")}
            <input className="admin-input" value={alt} onChange={(event) => setAlt(event.target.value)} />
          </label>
          <Button type="button" disabled={!url.trim()} onClick={() => onInsert(url.trim(), alt.trim())}>
            <Check className="size-4" aria-hidden />
            {t(language, "editor.insertImage")}
          </Button>
        </div>
        <div className="rich-editor-media-list">
          <div className="flex items-center justify-between gap-3">
            <p className="label-eyebrow">{t(language, "media.page.title")}</p>
            <a href="/admin/media" className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
              {t(language, "common.open")}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          </div>
          {MEDIA_ASSETS.map((asset) => (
            <button
              key={asset.name}
              type="button"
              className="rich-editor-media-row"
              onClick={() => onInsert(asset.url, asset.alt)}
            >
              <span className="rich-editor-media-thumb" style={{ "--media-tone": asset.tone } as React.CSSProperties} />
              <span className="min-w-0 text-left">
                <span className="block truncate font-semibold">{asset.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{asset.url}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function VideoInsertDialog({
  language,
  onClose,
  onInsert,
}: {
  language: AdminLanguage;
  onClose: () => void;
  onInsert: (url: string) => void;
}): React.ReactElement {
  const [url, setUrl] = React.useState("");
  return (
    <div className="rich-editor-dialog-backdrop" role="presentation">
      <div className="rich-editor-dialog" role="dialog" aria-modal="true" aria-label={t(language, "editor.videoUrl")}>
        <DialogHeader title={t(language, "editor.insertVideo")} onClose={onClose} />
        <label className="grid gap-1 text-sm font-medium">
          {t(language, "editor.videoUrl")}
          <input className="admin-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="YouTube / Dailymotion URL" />
        </label>
        <Button type="button" className="mt-3" disabled={!url.trim()} onClick={() => onInsert(url.trim())}>
          <Video className="size-4" aria-hidden />
          {t(language, "editor.insertVideo")}
        </Button>
      </div>
    </div>
  );
}

function DialogHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <button type="button" className="row-action" onClick={onClose} aria-label="Close">
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

function runTextCommand(command: "undo" | "redo", input: HTMLTextAreaElement | null): void {
  input?.focus();
  document.execCommand(command);
}

function videoEmbed(rawUrl: string): string {
  const url = parseUrl(rawUrl);
  if (!url) return `<a href="${escapeAttribute(rawUrl)}">${escapeHtml(rawUrl)}</a>`;
  const youtube = youtubeId(url);
  if (youtube) {
    return `<iframe src="https://www.youtube.com/embed/${youtube}" title="YouTube video" loading="lazy" allowfullscreen></iframe>`;
  }
  const dailymotion = dailymotionId(url);
  if (dailymotion) {
    return `<iframe src="https://www.dailymotion.com/embed/video/${dailymotion}" title="Dailymotion video" loading="lazy" allowfullscreen></iframe>`;
  }
  return `<a href="${escapeAttribute(url.toString())}">${escapeHtml(url.toString())}</a>`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function youtubeId(url: URL): string | null {
  if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? null;
  if (!url.hostname.includes("youtube.com")) return null;
  if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/").filter(Boolean)[1] ?? null;
  return url.searchParams.get("v");
}

function dailymotionId(url: URL): string | null {
  if (url.hostname === "dai.ly") return url.pathname.split("/").filter(Boolean)[0] ?? null;
  if (!url.hostname.includes("dailymotion.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const videoIndex = parts.indexOf("video");
  return videoIndex >= 0 ? (parts[videoIndex + 1] ?? null) : null;
}

export function renderRichTextPreview(body: string, mode: EditorMode): string {
  if (mode === "html") return body;

  const output: string[] = [];
  let inList = false;
  let inOrderedList = false;

  for (const rawLine of body.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (inList) output.push("</ul>");
      if (inOrderedList) output.push("</ol>");
      inList = false;
      inOrderedList = false;
      continue;
    }
    if (trimmed.startsWith("<")) {
      if (inList) output.push("</ul>");
      if (inOrderedList) output.push("</ol>");
      inList = false;
      inOrderedList = false;
      output.push(trimmed);
      continue;
    }
    const image = trimmed.match(/^!\[(.*)]\((.*)\)$/);
    if (image) {
      output.push(`<figure><img src="${escapeAttribute(image[2] ?? "")}" alt="${escapeAttribute(image[1] ?? "")}" /></figure>`);
      continue;
    }
    const line = renderInlineMarkdown(trimmed);

    if (trimmed.startsWith("## ")) {
      if (inList) output.push("</ul>");
      if (inOrderedList) output.push("</ol>");
      inList = false;
      inOrderedList = false;
      output.push(`<h2>${renderInlineMarkdown(trimmed.slice(3))}</h2>`);
      continue;
    }

    if (trimmed.startsWith("- [ ] ")) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li><input type="checkbox" disabled /> ${renderInlineMarkdown(trimmed.slice(6))}</li>`);
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${renderInlineMarkdown(trimmed.slice(2))}</li>`);
      continue;
    }

    if (/^\d+\.\s/.test(trimmed)) {
      if (!inOrderedList) {
        output.push("<ol>");
        inOrderedList = true;
      }
      output.push(`<li>${renderInlineMarkdown(trimmed.replace(/^\d+\.\s/, ""))}</li>`);
      continue;
    }

    if (inList) output.push("</ul>");
    if (inOrderedList) output.push("</ol>");
    inList = false;
    inOrderedList = false;
    output.push(`<p>${line}</p>`);
  }

  if (inList) output.push("</ul>");
  if (inOrderedList) output.push("</ol>");
  return output.join("");
}

function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[(.+?)]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
