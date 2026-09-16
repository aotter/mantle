import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bold,
  Code2,
  ImageIcon,
  Images,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Redo2,
  Strikethrough,
  Table2,
  Type,
  Undo2,
  Upload,
} from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { SiteInfo } from "../../lib/types";
import { Textarea } from "@/components/ui/textarea";
import { primaryPublicUrl, uploadMediaAsset } from "../media/media-upload";
import { MediaInsertDialog, ToolbarButton, ToolbarDivider, runTextCommand } from "./editor-chrome";
import { renderMarkdownPreview } from "./markdown-preview";
import {
  applyMarkdownInsert,
  markdownImageSnippet,
  type MarkdownToolbarInsert,
} from "./markdown-snippets";

export function MarkdownEditor({
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
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [mediaOpen, setMediaOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });

  const apply = React.useCallback(
    (key: MarkdownToolbarInsert, placeholder = "") => {
      const input = textRef.current;
      const start = input?.selectionStart ?? value.length;
      const end = input?.selectionEnd ?? value.length;
      const result = applyMarkdownInsert(value, start, end, key, placeholder);
      onChange(result.next);
      window.requestAnimationFrame(() => {
        input?.focus();
        input?.setSelectionRange(result.cursorStart, result.cursorEnd);
      });
    },
    [onChange, value],
  );

  const insertImage = React.useCallback(
    (url: string, alt: string) => {
      const input = textRef.current;
      const start = input?.selectionStart ?? value.length;
      const end = input?.selectionEnd ?? value.length;
      const prefix = value.slice(0, start).endsWith("\n") || start === 0 ? "" : "\n\n";
      const snippet = `${prefix}${markdownImageSnippet(url, alt)}`;
      const next = `${value.slice(0, start)}${snippet}${value.slice(end)}`;
      onChange(next);
      window.requestAnimationFrame(() => {
        const cursor = start + snippet.length;
        input?.focus();
        input?.setSelectionRange(cursor, cursor);
      });
    },
    [onChange, value],
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
      insertImage(url, committed.alt ?? file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function applyTextStyle(style: string): void {
    if (style === "paragraph") return;
    if (/^h[1-6]$/.test(style)) {
      apply(style as MarkdownToolbarInsert, t(language, "editor.headingPlaceholder"));
      return;
    }
    if (style === "quote") apply("quote");
    if (style === "code") apply("codeFence");
  }

  const preview = renderMarkdownPreview(value);

  return (
    <div data-string-editor="markdown">
      <div
        className="flex flex-wrap items-center gap-1 rounded-t-lg border bg-muted/30 p-1"
        role="toolbar"
        aria-label={t(language, "editor.markdownToolbar")}
      >
        <ToolbarButton title={t(language, "editor.undo")} onClick={() => runTextCommand("undo", textRef.current)}>
          <Undo2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.redo")} onClick={() => runTextCommand("redo", textRef.current)}>
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
        <ToolbarButton title={t(language, "editor.bold")} onClick={() => apply("bold", t(language, "editor.selectedText"))}>
          <Bold className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.italic")} onClick={() => apply("italic", t(language, "editor.selectedText"))}>
          <Italic className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.strike")} onClick={() => apply("strike", t(language, "editor.selectedText"))}>
          <Strikethrough className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.inlineCode")} onClick={() => apply("inlineCode")}>
          <Code2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.bulletList")} onClick={() => apply("bulletList")}>
          <List className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.numberList")} onClick={() => apply("numberList")}>
          <ListOrdered className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.checkList")} onClick={() => apply("checkList")}>
          <ListChecks className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.indent")} onClick={() => apply("indent")}>
          <IndentIncrease className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.link")} onClick={() => apply("link", t(language, "editor.linkText"))}>
          <Link className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.table")} onClick={() => apply("table")}>
          <Table2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.mediaLibrary")} onClick={() => setMediaOpen(true)}>
          <Images className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.imageUrl")} onClick={() => setMediaOpen(true)}>
          <ImageIcon className="size-4" aria-hidden />
        </ToolbarButton>
      </div>

      <Textarea
        ref={textRef}
        aria-label={label}
        className={`${compact ? "min-h-32" : "min-h-64"} rounded-none border-t-0 resize-y font-mono`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="border-x bg-muted/20 px-3 py-1 text-xs font-medium text-muted-foreground">
        {t(language, "editor.preview")}
      </p>
      <div
        className={`mantle-md-preview ${compact ? "min-h-24" : "min-h-40"}`}
        aria-label={t(language, "editor.markdownPreview")}
        dangerouslySetInnerHTML={{ __html: preview }}
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
    </div>
  );
}
