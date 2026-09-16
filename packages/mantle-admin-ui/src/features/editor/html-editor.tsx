import * as React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code2, Italic, Link, List, ListOrdered, Quote, Redo2, Strikethrough, Underline, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HtmlEditor({ value, onChange }: { value: string; onChange: (value: string) => void }): React.ReactElement {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value,
    immediatelyRender: false,
    editorProps: { attributes: { class: "mantle-html-editor min-h-32 px-3 py-2 outline-none" } },
    onUpdate: ({ editor: next }) => onChange(next.isEmpty ? "" : next.getHTML()),
  });
  React.useEffect(() => {
    if (editor && editor.getHTML() !== value) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);
  if (!editor) return <div className="min-h-32 rounded-md border" />;
  const button = (label: string, icon: React.ReactNode, active: boolean, run: () => void) => (
    <Button type="button" variant={active ? "secondary" : "ghost"} size="icon-sm" aria-label={label} title={label} onClick={run}>{icon}</Button>
  );
  return <div className="overflow-hidden rounded-md border bg-background">
    <div className="flex flex-wrap gap-1 border-b bg-muted/30 p-1" role="toolbar" aria-label="HTML editor toolbar">
      {button("Undo", <Undo2 aria-hidden />, false, () => editor.chain().focus().undo().run())}
      {button("Redo", <Redo2 aria-hidden />, false, () => editor.chain().focus().redo().run())}
      {button("Bold", <Bold aria-hidden />, editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
      {button("Italic", <Italic aria-hidden />, editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
      {button("Underline", <Underline aria-hidden />, editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run())}
      {button("Strikethrough", <Strikethrough aria-hidden />, editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run())}
      {button("Bullet list", <List aria-hidden />, editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
      {button("Numbered list", <ListOrdered aria-hidden />, editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
      {button("Quote", <Quote aria-hidden />, editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run())}
      {button("Code block", <Code2 aria-hidden />, editor.isActive("codeBlock"), () => editor.chain().focus().toggleCodeBlock().run())}
      {button("Link", <Link aria-hidden />, editor.isActive("link"), () => {
        const href = window.prompt("Link URL", editor.getAttributes("link").href ?? "https://");
        if (href === null) return;
        if (href.trim()) editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
        else editor.chain().focus().unsetLink().run();
      })}
    </div>
    <EditorContent editor={editor} />
  </div>;
}
