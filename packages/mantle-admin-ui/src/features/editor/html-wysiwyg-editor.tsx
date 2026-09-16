import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code2,
  Highlighter,
  ImageIcon,
  Images,
  Italic,
  Link,
  List,
  ListOrdered,
  Redo2,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  Upload,
  Video,
} from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { SiteInfo } from "../../lib/types";
import { primaryPublicUrl, uploadMediaAsset } from "../media/media-upload";
import {
  LinkInsertDialog,
  MediaInsertDialog,
  ToolbarButton,
  ToolbarDivider,
  VideoInsertDialog,
} from "./editor-chrome";
import { escapeAttr, sanitizeHtml, videoEmbedHtml } from "./html-sanitize";

export function HtmlWysiwygEditor({
  value,
  onChange,
  compact = false,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  label: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const editorRef = React.useRef<HTMLDivElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const lastEmitted = React.useRef(value);
  const [mediaOpen, setMediaOpen] = React.useState(false);
  const [videoOpen, setVideoOpen] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });

  React.useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (el.contains(document.activeElement)) return;
    if (value === lastEmitted.current && el.innerHTML === value) return;
    if (el.innerHTML === value) {
      lastEmitted.current = value;
      return;
    }
    el.innerHTML = value;
    lastEmitted.current = value;
  }, [value]);

  const emit = React.useCallback((rewrite = false) => {
    const el = editorRef.current;
    if (!el) return;
    const html = sanitizeHtml(el.innerHTML);
    if (rewrite && el.innerHTML !== html) el.innerHTML = html;
    lastEmitted.current = html;
    onChange(html);
  }, [onChange]);

  function run(command: string, commandValue?: string): void {
    editorRef.current?.focus();
    document.execCommand(command, false, commandValue);
    emit();
  }

  function insertHtml(html: string): void {
    editorRef.current?.focus();
    document.execCommand("insertHTML", false, html);
    emit(true);
  }

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
      if (!url) throw new Error(t(language, "common.unknownError"));
      insertImage(url, committed.alt ?? file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function insertImage(url: string, alt: string): void {
    insertHtml(`<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}">`);
  }

  function applyTextStyle(style: string): void {
    if (style === "paragraph") {
      run("formatBlock", "P");
      return;
    }
    if (/^h[1-6]$/.test(style)) {
      run("formatBlock", style.toUpperCase());
      return;
    }
    if (style === "quote") run("formatBlock", "BLOCKQUOTE");
    if (style === "code") insertHtml("<pre><code></code></pre>");
  }

  return (
    <div data-string-editor="html">
      <div
        className="flex flex-wrap items-center gap-1 rounded-t-lg border bg-muted/30 p-1"
        role="toolbar"
        aria-label={t(language, "editor.htmlToolbar")}
      >
        <ToolbarButton title={t(language, "editor.undo")} onClick={() => run("undo")}>
          <Undo2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.redo")} onClick={() => run("redo")}>
          <Redo2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
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
            <option value="paragraph">{t(language, "editor.paragraph")}</option>
            <option value="h1">H1</option>
            <option value="h2">H2</option>
            <option value="h3">H3</option>
            <option value="h4">H4</option>
            <option value="h5">H5</option>
            <option value="h6">H6</option>
            <option value="quote">{t(language, "editor.quote")}</option>
            <option value="code">{t(language, "editor.code")}</option>
          </select>
        </label>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.bold")} onClick={() => run("bold")}>
          <Bold className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.italic")} onClick={() => run("italic")}>
          <Italic className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.underline")} onClick={() => run("underline")}>
          <Underline className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.strike")} onClick={() => run("strikeThrough")}>
          <Strikethrough className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.inlineCode")} onClick={() => insertHtml("<code>code</code>")}>
          <Code2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.highlight")} onClick={() => run("hiliteColor", "#fde68a")}>
          <Highlighter className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.alignLeft")} onClick={() => run("justifyLeft")}>
          <AlignLeft className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.alignCenter")} onClick={() => run("justifyCenter")}>
          <AlignCenter className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.alignRight")} onClick={() => run("justifyRight")}>
          <AlignRight className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.bulletList")} onClick={() => run("insertUnorderedList")}>
          <List className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.numberList")} onClick={() => run("insertOrderedList")}>
          <ListOrdered className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.link")} onClick={() => setLinkOpen(true)}>
          <Link className="size-4" aria-hidden />
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
      <div
        ref={editorRef}
        className={`mantle-html-wysiwyg ${compact ? "min-h-32" : "min-h-64"}`}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        suppressContentEditableWarning
        onInput={() => emit()}
        onBlur={() => emit(true)}
        onPaste={(event) => {
          const html = event.clipboardData.getData("text/html");
          if (!html) return;
          event.preventDefault();
          insertHtml(sanitizeHtml(html));
        }}
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
          onInsert={(url) => {
            insertHtml(videoEmbedHtml(url));
            setVideoOpen(false);
          }}
        />
      ) : null}
      {linkOpen ? (
        <LinkInsertDialog
          language={language}
          onClose={() => setLinkOpen(false)}
          onInsert={(url, text) => {
            const label = text || url;
            insertHtml(`<a href="${escapeAttr(url)}">${escapeAttr(label)}</a>`);
            setLinkOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
