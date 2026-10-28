import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Images } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@aotter/mantle-ui/kit";
import { useAdminContext } from "./hooks-context";
import { usePreferences } from "./preferences";
import { t } from "./i18n";
import { api } from "../lib/api";
import type { SiteInfo } from "../lib/types";
import { MediaBrowser } from "../features/media/media-library-view";

/** A selected committed asset. A private or unresolved asset may have no public URL. */
export interface MediaSelection {
  readonly id: string;
  readonly primaryUrl: string | null;
}

export interface MediaPickerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called only for an explicit selection; cancelling never clears the field. */
  readonly onSelect: (asset: MediaSelection) => void;
  /** An exact site media purpose for uploads. Omit to select existing assets only. */
  readonly uploadPurpose?: string;
  /** Hides the picker and prevents selection or upload while the owning input cannot edit. */
  readonly readOnly?: boolean;
}

/**
 * Browser-only picker inside MantleAdmin, for custom inputs and pages. Uses the current caller's existing Admin media
 * routes. Upload commits an asset to the library; selecting it is a separate explicit action. Closing/unmounting never
 * selects a late upload or deletes a committed asset. Key the owning custom input by record identity when reusing it.
 */
export function MediaPicker(props: MediaPickerProps): React.ReactElement | null {
  const { transport } = useAdminContext();
  if (transport.surface !== "browser" || !props.open || props.readOnly) return null;
  return <OpenMediaPicker {...props} />;
}

function OpenMediaPicker({ onOpenChange, onSelect, uploadPurpose }: MediaPickerProps): React.ReactElement {
  const { language } = usePreferences();
  const [search, setSearch] = React.useState("");
  const site = useQuery<SiteInfo>({ queryKey: ["site"], queryFn: () => api.get<SiteInfo>("/site") });
  const purposes = (site.data?.media?.purposes ?? []).filter(purpose => purpose.name === uploadPurpose);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t(language, "common.close")} className="max-h-[85vh] w-full max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(language, "media.pickTitle")}</DialogTitle>
          <DialogDescription>{t(language, "media.pickDescription")}</DialogDescription>
        </DialogHeader>
        <MediaBrowser language={language} purposes={purposes} preferredPurpose={uploadPurpose} searchTerm={search}
          emptyIcon={Images} showSearch onSearch={setSearch} onPick={item => {
            onSelect({ id: item.id, primaryUrl: item.primaryUrl ?? null });
            onOpenChange(false);
          }} />
      </DialogContent>
    </Dialog>
  );
}
