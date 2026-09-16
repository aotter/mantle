import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code2,
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
import { cn } from "@/lib/utils";
import { primaryPublicUrl, uploadMediaAsset } from "../media/media-upload";
import {
  LinkInsertDialog,
  MediaInsertDialog,
  ToolbarButton,
  ToolbarDivider,
  VideoInsertDialog,
} from "./editor-chrome";
import { htmlImage, serializeHtml, videoEmbed } from "./html-serialize";
import { RICH_CONTENT_CLASS } from "./rich-content-class";

export function HtmlEditor({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}): React.ReactElement {
  const { language } = usePreferences();
  const editorRef = React.useRef<HTMLDivElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [mediaOpen, setMediaOpen] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [videoOpen, setVideoOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const minHeight = compact ? "min-h-32" : "min-h-64";

  React.useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    if (el.innerHTML === value) return;
    el.innerHTML = value;
  }, [value]);

  const emit = React.useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    onChange(serializeHtml(el.innerHTML));
  }, [onChange]);

  const run = React.useCallback(
    (command: string, arg?: string) => {
      editorRef.current?.focus();
      document.execCommand(command, false, arg);
      emit();
    },
    [emit],
  );

  const insertHtml = React.useCallback(
    (html: string) => {
      editorRef.current?.focus();
      document.execCommand("insertHTML", false, html);
      emit();
    },
    [emit],
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
      if (!url) throw new Error(t(language, "common.unknownError"));
      insertHtml(htmlImage(url, committed.alt ?? file.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function applyTextStyle(style: string): void {
    if (style === "paragraph") {
      run("formatBlock", "p");
      return;
    }
    if (/^h[1-6]$/.test(style)) {
      run("formatBlock", style);
      return;
    }
    if (style === "quote") run("formatBlock", "blockquote");
    if (style === "code") run("formatBlock", "pre");
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div
        className="flex flex-wrap items-center gap-1 border-b bg-muted/30 p-1"
        aria-label={t(language, "editor.toolbarHtml")}
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
        <ToolbarButton
          title={t(language, "editor.inlineCode")}
          onClick={() => insertHtml(`<code>${window.getSelection()?.toString() || ""}</code>`)}
        >
          <Code2 className="size-4" aria-hidden />
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
        role="textbox"
        aria-multiline="true"
        aria-label={t(language, "editor.mode.html")}
        contentEditable
        suppressContentEditableWarning
        className={cn(
          minHeight,
          "resize-y overflow-auto px-3 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          RICH_CONTENT_CLASS,
        )}
        onInput={emit}
        onBlur={emit}
      />
      {error ? <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {uploading ? <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t(language, "editor.uploading")}</p> : null}
      {mediaOpen ? (
        <MediaInsertDialog
          language={language}
          onClose={() => setMediaOpen(false)}
          onInsert={(url, alt) => {
            insertHtml(htmlImage(url, alt));
            setMediaOpen(false);
          }}
        />
      ) : null}
      {linkOpen ? (
        <LinkInsertDialog
          language={language}
          onClose={() => setLinkOpen(false)}
          onInsert={(url) => {
            run("createLink", url);
            setLinkOpen(false);
          }}
        />
      ) : null}
      {videoOpen ? (
        <VideoInsertDialog
          language={language}
          onClose={() => setVideoOpen(false)}
          onInsert={(url) => {
            insertHtml(videoEmbed(url));
            setVideoOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
