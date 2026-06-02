import * as React from "react";
import { Save } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { Button } from "../../ui/button";
import { PageHeader, SectionCard } from "../../ui/page";
import { RichTextEditor, renderRichTextPreview, type EditorMode } from "./rich-text-editor";

const SAMPLE =
  "## 商品介紹\\n\\n用清楚的段落描述服務內容、交付方式與購買須知。\\n\\n- 支援 Markdown\\n- 可切換 HTML source\\n- 可用 Rich Editor 快速排版";

export function EditorView(): React.ReactElement {
  const { language } = usePreferences();
  const [mode, setMode] = React.useState<EditorMode>("rich");
  const [body, setBody] = React.useState(SAMPLE);

  const htmlPreview = React.useMemo(() => renderRichTextPreview(body, mode), [body, mode]);

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

          <RichTextEditor
            label={t(language, "editor.bodyLabel")}
            value={body}
            onChange={setBody}
            mode={mode}
            onModeChange={setMode}
          />
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
