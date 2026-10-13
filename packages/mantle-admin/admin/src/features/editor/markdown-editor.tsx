import * as React from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aotter/mantle-ui/kit";
import { Textarea } from "@aotter/mantle-ui/kit";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize];

export function MarkdownEditor({ value, onChange }: { value: string; onChange: (value: string) => void }): React.ReactElement {
  const { language } = usePreferences();
  return <div className="space-y-2">
    <p className="text-xs text-muted-foreground">{t(language, "editor.markdownHint")}</p>
    <Tabs defaultValue="preview">
      <TabsList>
        <TabsTrigger value="source">{t(language, "entryWorkbench.editEntry")}</TabsTrigger>
        <TabsTrigger value="preview">{t(language, "editor.preview")}</TabsTrigger>
      </TabsList>
      <TabsContent value="source">
        <Textarea className="min-h-32 resize-y font-mono" value={value} onChange={(event) => onChange(event.target.value)} />
      </TabsContent>
      <TabsContent value="preview">
        <div className="mantle-markdown-preview min-h-32 overflow-auto rounded-md border bg-background px-3 py-2">
          <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{value}</ReactMarkdown>
        </div>
      </TabsContent>
    </Tabs>
  </div>;
}
