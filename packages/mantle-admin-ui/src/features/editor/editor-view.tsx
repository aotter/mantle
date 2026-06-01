import * as React from "react";
import { Bold, Code2, Heading2, Image, Italic, Link, List, Save } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { Button } from "../../ui/button";
import { PageHeader, SectionCard } from "../../ui/page";

const SAMPLE =
  "## 商品介紹\\n\\n用清楚的段落描述服務內容、交付方式與購買須知。\\n\\n- 支援 Markdown\\n- 可切換 HTML source\\n- 可用 Rich Editor 快速排版";

export function EditorView(): React.ReactElement {
  const { language } = usePreferences();
  const [mode, setMode] = React.useState<"markdown" | "html" | "rich">("markdown");
  const [body, setBody] = React.useState(SAMPLE);

  const htmlPreview = React.useMemo(() => renderPreview(body, mode), [body, mode]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AotterMantle"
        title={t(language, "editor.page.title")}
        description={t(language, "editor.page.body")}
        actions={
          <Button>
            <Save className="size-4" aria-hidden />
            {t(language, "editor.saveDraft")}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <SectionCard className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm font-medium">
              {t(language, "editor.titleLabel")}
              <input className="admin-input" defaultValue="品牌定位快思衝刺" />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              {t(language, "editor.slugLabel")}
              <input className="admin-input font-mono" defaultValue="brand-positioning-sprint" />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="segmented-control">
              <button type="button" data-active={mode === "markdown"} onClick={() => setMode("markdown")}>
                {t(language, "editor.mode.markdown")}
              </button>
              <button type="button" data-active={mode === "html"} onClick={() => setMode("html")}>
                {t(language, "editor.mode.html")}
              </button>
              <button type="button" data-active={mode === "rich"} onClick={() => setMode("rich")}>
                {t(language, "editor.mode.rich")}
              </button>
            </div>
            <div className="editor-toolbar" aria-label={t(language, "editor.insertBlock")}>
              {[Heading2, Bold, Italic, Link, List, Image, Code2].map((Icon, index) => (
                <button key={index} type="button">
                  <Icon className="size-4" aria-hidden />
                </button>
              ))}
            </div>
          </div>

          <label className="grid gap-2 text-sm font-medium">
            {t(language, "editor.bodyLabel")}
            <textarea
              className="admin-textarea"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
        </SectionCard>

        <SectionCard className="space-y-4">
          <div>
            <p className="label-eyebrow">{t(language, "editor.preview")}</p>
            <div className="editor-preview" dangerouslySetInnerHTML={{ __html: htmlPreview }} />
          </div>
          <div className="grid gap-3 text-sm text-muted-foreground">
            <p>{t(language, "editor.markdownHint")}</p>
            <p>{t(language, "editor.htmlHint")}</p>
            <p>{t(language, "editor.richHint")}</p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function renderPreview(body: string, mode: "markdown" | "html" | "rich"): string {
  if (mode === "html") return body;

  const output: string[] = [];
  let inList = false;

  for (const rawLine of body.split("\n")) {
    const line = escapeHtml(rawLine.trim());

    if (!line) {
      if (inList) {
        output.push("</ul>");
        inList = false;
      }
      continue;
    }

    if (line.startsWith("## ")) {
      if (inList) {
        output.push("</ul>");
        inList = false;
      }
      output.push(`<h2>${line.slice(3)}</h2>`);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${line.slice(2)}</li>`);
      continue;
    }

    if (inList) {
      output.push("</ul>");
      inList = false;
    }
    output.push(`<p>${line}</p>`);
  }

  if (inList) output.push("</ul>");
  return output.join("");
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
