import * as React from "react";
import { Check, Video } from "lucide-react";
import { t } from "../../app/i18n";
import type { AdminLanguage } from "../../app/preferences";
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

export function ToolbarButton({
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

export function ToolbarDivider(): React.ReactElement {
  return <Separator orientation="vertical" className="mx-1 h-5" aria-hidden />;
}

export function MediaInsertDialog({
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
      <DialogContent closeLabel={t(language, "common.close")}>
        <DialogHeader>
          <DialogTitle>{t(language, "editor.insertImage")}</DialogTitle>
          <DialogDescription className="sr-only">{t(language, "editor.mediaLibrary")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="editor-image-url">{t(language, "editor.imageUrl")}</Label>
            <Input
              id="editor-image-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="editor-image-alt">{t(language, "media.alt")}</Label>
            <Input id="editor-image-alt" value={alt} onChange={(event) => setAlt(event.target.value)} />
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

export function LinkInsertDialog({
  language,
  onClose,
  onInsert,
}: {
  language: AdminLanguage;
  onClose: () => void;
  onInsert: (url: string) => void;
}): React.ReactElement {
  const [url, setUrl] = React.useState("https://");
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent closeLabel={t(language, "common.close")}>
        <DialogHeader>
          <DialogTitle>{t(language, "editor.link")}</DialogTitle>
          <DialogDescription className="sr-only">{t(language, "editor.linkUrl")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="editor-link-url">{t(language, "editor.linkUrl")}</Label>
          <Input
            id="editor-link-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://"
          />
        </div>
        <DialogFooter>
          <Button type="button" disabled={!url.trim()} onClick={() => onInsert(url.trim())}>
            {t(language, "editor.link")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VideoInsertDialog({
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
      <DialogContent closeLabel={t(language, "common.close")}>
        <DialogHeader>
          <DialogTitle>{t(language, "editor.insertVideo")}</DialogTitle>
          <DialogDescription className="sr-only">{t(language, "editor.videoUrl")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="editor-video-url">{t(language, "editor.videoUrl")}</Label>
          <Input
            id="editor-video-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t(language, "editor.videoUrl")}
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
