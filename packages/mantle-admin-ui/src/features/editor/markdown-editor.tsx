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
  Wand2,
} from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { SiteInfo } from "../../lib/types";
import { Textarea } from "@/components/ui/textarea";
import { primaryPublicUrl, uploadMediaAsset } from "../media/media-upload";
import { MediaInsertDialog, ToolbarButton, ToolbarDivider } from "./editor-chrome";
import {
  insertMarkdownBlock,
  markdownHeadingPrefix,
  markdownImage,
  MARKDOWN_TOOLBAR_BLOCKS,
  MARKDOWN_TOOLBAR_WRAPS,
  wrapMarkdownSelection,
  type MarkdownEdit,
} from "./markdown-insert";
import { renderMarkdownPreview } from "./markdown-preview";
import { RICH_CONTENT_CLASS } from "./rich-content-class";

export function MarkdownEditor({
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
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const preview = React.useMemo(() => renderMarkdownPreview(value), [value]);
  const minHeight = compact ? "min-h-32" : "min-h-64";

  const applyEdit = React.useCallback(
    (edit: MarkdownEdit) => {
      onChange(edit.next);
      window.requestAnimationFrame(() => {
        const input = textRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(edit.cursorStart, edit.cursorEnd);
      });
    },
    [onChange],
  );

  const selection = React.useCallback((): { start: number; end: number } => {
    const input = textRef.current;
    return { start: input?.selectionStart ?? value.length, end: input?.selectionEnd ?? value.length };
  }, [value.length]);

  const wrap = React.useCallback(
    (before: string, after = "", placeholder = "") => {
      const { start, end } = selection();
      applyEdit(wrapMarkdownSelection(value, start, end, before, after, placeholder));
    },
    [applyEdit, selection, value],
  );

  const insertBlock = React.useCallback(
    (block: string) => {
      const { start, end } = selection();
      applyEdit(insertMarkdownBlock(value, start, end, block));
    },
    [applyEdit, selection, value],
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
      insertBlock(markdownImage(url, committed.alt ?? file.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function applyTextStyle(style: string): void {
    if (style === "paragraph") return;
    const selected = t(language, "editor.headingPlaceholder");
    if (/^h[1-6]$/.test(style)) {
      wrap(markdownHeadingPrefix(Number(style.slice(1))), "", selected);
      return;
    }
    if (style === "quote") insertBlock(MARKDOWN_TOOLBAR_BLOCKS.quote);
    if (style === "code") wrap(MARKDOWN_TOOLBAR_BLOCKS.codeFence.before, MARKDOWN_TOOLBAR_BLOCKS.codeFence.after);
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div
        className="flex flex-wrap items-center gap-1 border-b bg-muted/30 p-1"
        aria-label={t(language, "editor.toolbarMarkdown")}
      >
        <ToolbarButton title={t(language, "editor.undo")} onClick={() => runTextCommand("undo", textRef.current)}>
          <Undo2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.redo")} onClick={() => runTextCommand("redo", textRef.current)}>
          <Redo2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.aiClean")} onClick={() => insertBlock(MARKDOWN_TOOLBAR_BLOCKS.quote)}>
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
        <ToolbarButton title={t(language, "editor.bold")} onClick={() => wrap(MARKDOWN_TOOLBAR_WRAPS.bold.before, MARKDOWN_TOOLBAR_WRAPS.bold.after, t(language, "editor.selectedText"))}>
          <Bold className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.italic")} onClick={() => wrap(MARKDOWN_TOOLBAR_WRAPS.italic.before, MARKDOWN_TOOLBAR_WRAPS.italic.after, t(language, "editor.selectedText"))}>
          <Italic className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.strike")} onClick={() => wrap(MARKDOWN_TOOLBAR_WRAPS.strike.before, MARKDOWN_TOOLBAR_WRAPS.strike.after, t(language, "editor.selectedText"))}>
          <Strikethrough className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.inlineCode")} onClick={() => wrap(MARKDOWN_TOOLBAR_WRAPS.inlineCode.before, MARKDOWN_TOOLBAR_WRAPS.inlineCode.after)}>
          <Code2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.bulletList")} onClick={() => insertBlock(MARKDOWN_TOOLBAR_BLOCKS.bulletList)}>
          <List className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.numberList")} onClick={() => insertBlock(MARKDOWN_TOOLBAR_BLOCKS.numberList)}>
          <ListOrdered className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.checkList")} onClick={() => insertBlock(MARKDOWN_TOOLBAR_BLOCKS.checkList)}>
          <ListChecks className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.indent")} onClick={() => wrap("  ", "", "")}>
          <IndentIncrease className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title={t(language, "editor.link")} onClick={() => wrap(MARKDOWN_TOOLBAR_WRAPS.link.before, MARKDOWN_TOOLBAR_WRAPS.link.after, t(language, "editor.linkText"))}>
          <Link className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.table")} onClick={() => insertBlock(MARKDOWN_TOOLBAR_BLOCKS.table)}>
          <Table2 className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.mediaLibrary")} onClick={() => setMediaOpen(true)}>
          <Images className="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton title={t(language, "editor.imageUrl")} onClick={() => setMediaOpen(true)}>
          <ImageIcon className="size-4" aria-hidden />
        </ToolbarButton>
      </div>

      <div className="grid md:grid-cols-2">
        <Textarea
          ref={textRef}
          aria-label={t(language, "editor.source")}
          className={`${minHeight} rounded-none border-0 resize-y font-mono md:border-r`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <div
          className={`${minHeight} overflow-auto bg-muted/20 p-3 ${RICH_CONTENT_CLASS}`}
          aria-label={t(language, "editor.preview")}
        >
          {value.trim()
            ? <div dangerouslySetInnerHTML={{ __html: preview }} />
            : <p className="text-muted-foreground">{t(language, "editor.emptyPreview")}</p>}
        </div>
      </div>
      {error ? <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {uploading ? <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t(language, "editor.uploading")}</p> : null}
      {mediaOpen ? (
        <MediaInsertDialog
          language={language}
          onClose={() => setMediaOpen(false)}
          onInsert={(url, alt) => {
            insertBlock(markdownImage(url, alt));
            setMediaOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function runTextCommand(command: "undo" | "redo", input: HTMLTextAreaElement | null): void {
  input?.focus();
  document.execCommand(command);
}
