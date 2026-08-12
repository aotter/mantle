import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Check,
  Code2,
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
} from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { SiteInfo } from "../../lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { primaryPublicUrl, uploadMediaAsset } from "../media/media-upload";

export function RichTextEditor({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}): React.ReactElement {
  const { language } = usePreferences();
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [mediaOpen, setMediaOpen] = React.useState(false);
  const [videoOpen, setVideoOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });

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

  async function uploadImage(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    try {
      const committed = await uploadMediaAsset({
        file,
        purposes: site.data?.media?.purposes ?? [],
        preferredPurpose: "content",
        language,
      });
      const url = primaryPublicUrl(committed);
      if (!url) throw new Error("Uploaded media has no public URL.");
      insertImage(url, committed.alt ?? file.name);
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

  return (
    <div>
      <div
        className="flex flex-wrap items-center gap-1 rounded-t-lg border bg-muted/30 p-1"
        aria-label={t(language, "editor.toolbar")}
      >
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
        <label
          className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title={t(language, "editor.textStyle")}
        >
          <Type className="size-4" aria-hidden />
          <select
            className="bg-transparent text-sm outline-none"
            onChange={(event) => {
              applyTextStyle(event.target.value);
              event.target.value = "paragraph";
            }}
            defaultValue="paragraph"
          >
            <option value="paragraph">Paragraph</option>
            <option value="h1">H1</option>
            <option value="h2">H2</option>
            <option value="h3">H3</option>
            <option value="h4">H4</option>
            <option value="h5">H5</option>
            <option value="h6">H6</option>
            <option value="quote">Quote</option>
            <option value="code">Code</option>
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

      <Textarea
        ref={textRef}
        className={`${compact ? "min-h-32" : "min-h-64"} rounded-t-none border-t-0 resize-y font-mono`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {uploading ? <p className="mt-2 text-xs text-muted-foreground">{t(language, "editor.uploading")}</p> : null}
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
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

function ToolbarDivider(): React.ReactElement {
  return <Separator orientation="vertical" className="mx-1 h-5" aria-hidden />;
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(language, "editor.insertImage")}</DialogTitle>
          <DialogDescription className="sr-only">{t(language, "editor.mediaLibrary")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="rich-editor-image-url">{t(language, "editor.imageUrl")}</Label>
            <Input
              id="rich-editor-image-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rich-editor-image-alt">{t(language, "media.alt")}</Label>
            <Input id="rich-editor-image-alt" value={alt} onChange={(event) => setAlt(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" disabled={!url.trim()} onClick={() => onInsert(url.trim(), alt.trim())}>
            <Check className="size-4" aria-hidden />
            {t(language, "editor.insertImage")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(language, "editor.insertVideo")}</DialogTitle>
          <DialogDescription className="sr-only">{t(language, "editor.videoUrl")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="rich-editor-video-url">{t(language, "editor.videoUrl")}</Label>
          <Input
            id="rich-editor-video-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="YouTube / Dailymotion URL"
          />
        </div>
        <DialogFooter>
          <Button type="button" disabled={!url.trim()} onClick={() => onInsert(url.trim())}>
            <Video className="size-4" aria-hidden />
            {t(language, "editor.insertVideo")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
