import * as React from "react";
import {
  ArrowDownUp,
  Check,
  Copy,
  Crop,
  ImagePlus,
  Search,
  Tags,
} from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { Button } from "../../ui/button";
import { PageHeader, SectionCard } from "../../ui/page";

interface MediaAsset {
  readonly name: string;
  readonly type: string;
  readonly tag: "product" | "brand" | "content";
  readonly alt: string;
  readonly url: string;
  readonly size: string;
  readonly createdAt: string;
  readonly tone: string;
}

const MEDIA: ReadonlyArray<MediaAsset> = [
  {
    name: "product-cover-01",
    type: "image/webp",
    tag: "product",
    alt: "商品主視覺",
    url: "/media/product-cover-01.webp",
    size: "1920 x 1440",
    createdAt: "2026-06-01",
    tone: "linear-gradient(135deg,#e8dfcf,#a9c0b5 45%,#2b5b55)",
  },
  {
    name: "brand-story",
    type: "image/jpeg",
    tag: "brand",
    alt: "品牌介紹圖片",
    url: "/media/brand-story.jpg",
    size: "1600 x 1200",
    createdAt: "2026-05-31",
    tone: "linear-gradient(135deg,#f3dccb,#d8aa72 48%,#213d59)",
  },
  {
    name: "workflow-map",
    type: "image/png",
    tag: "content",
    alt: "流程示意圖",
    url: "/media/workflow-map.png",
    size: "1440 x 1080",
    createdAt: "2026-05-30",
    tone: "linear-gradient(135deg,#e9edf4,#9fb2ca 45%,#253453)",
  },
  {
    name: "homepage-hero",
    type: "image/webp",
    tag: "content",
    alt: "首頁主視覺",
    url: "/media/homepage-hero.webp",
    size: "2400 x 1350",
    createdAt: "2026-05-29",
    tone: "linear-gradient(135deg,#f7f1df,#91b7a7 44%,#173f45)",
  },
];

type MediaFilter = "all" | MediaAsset["tag"];
type MediaSort = "newest" | "name" | "type";

export function MediaLibraryView(): React.ReactElement {
  const { language } = usePreferences();
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<MediaFilter>("all");
  const [sort, setSort] = React.useState<MediaSort>("newest");
  const [copied, setCopied] = React.useState<string | null>(null);

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...MEDIA]
      .filter((asset) => filter === "all" || asset.tag === filter)
      .filter((asset) =>
        !q || [asset.name, asset.type, asset.tag, asset.alt, asset.url].join(" ").toLowerCase().includes(q),
      )
      .sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        if (sort === "type") return a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
        return b.createdAt.localeCompare(a.createdAt);
      });
  }, [filter, query, sort]);

  async function copyUrl(asset: MediaAsset): Promise<void> {
    try {
      const url = new URL(asset.url, window.location.origin).toString();
      await navigator.clipboard.writeText(url);
      setCopied(asset.name);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AotterMantle"
        title={t(language, "media.page.title")}
        description={t(language, "media.page.body")}
        actions={
          <Button>
            <ImagePlus className="size-4" aria-hidden />
            {t(language, "media.upload")}
          </Button>
        }
      />

      <SectionCard className="media-album">
        <div className="media-toolbar">
          <label className="admin-search media-search">
            <Search className="size-4" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(language, "media.search")}
            />
          </label>
          <div className="segmented-control media-filter" aria-label={t(language, "media.filter")}>
            {(["all", "product", "brand", "content"] as const).map((value) => (
              <button
                key={value}
                type="button"
                data-active={filter === value}
                onClick={() => setFilter(value)}
                title={mediaFilterLabel(language, value)}
              >
                {mediaFilterLabel(language, value)}
              </button>
            ))}
          </div>
          <label className="media-sort" title={t(language, "media.sort")}>
            <ArrowDownUp className="size-4" aria-hidden />
            <select value={sort} onChange={(event) => setSort(event.target.value as MediaSort)}>
              <option value="newest">{t(language, "media.sort.newest")}</option>
              <option value="name">{t(language, "media.sort.name")}</option>
              <option value="type">{t(language, "media.sort.type")}</option>
            </select>
          </label>
        </div>

        <div className="media-dropzone-compact">
          <ImagePlus className="size-5" aria-hidden />
          <strong>{t(language, "media.dropzone")}</strong>
          <span>{t(language, "media.dropzoneHint")}</span>
        </div>

        <div className="media-grid album-grid">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(language, "media.empty")}</p>
          ) : (
            rows.map((asset) => (
              <article key={asset.name} className="media-card album-card">
                <div className="media-thumb album-thumb" style={{ "--media-tone": asset.tone } as React.CSSProperties}>
                  <span className="media-kind">{asset.type.replace("image/", "").toUpperCase()}</span>
                </div>
                <div className="album-card-body">
                  <div className="album-title-row">
                    <div className="min-w-0">
                      <h2 className="truncate text-base" title={asset.name}>{asset.name}</h2>
                      <p className="truncate text-sm text-muted-foreground" title={asset.url}>{asset.url}</p>
                    </div>
                    <button
                      type="button"
                      className="row-action"
                      onClick={() => copyUrl(asset)}
                      title={t(language, "media.copyUrl")}
                      aria-label={t(language, "media.copyUrl")}
                    >
                      {copied === asset.name ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                    </button>
                  </div>
                  <div className="album-meta">
                    <span>{asset.size}</span>
                    <span>{asset.createdAt}</span>
                  </div>
                  <label className="grid gap-1 text-sm">
                    {t(language, "media.alt")}
                    <input className="admin-input" defaultValue={asset.alt} />
                  </label>
                  <div className="album-actions">
                    <span className="badge-status bg-accent text-accent-foreground">
                      <Tags className="mr-1 size-3" aria-hidden />
                      {asset.tag}
                    </span>
                    <Button variant="outline" size="sm" title={t(language, "media.crop")}>
                      <Crop className="size-3.5" aria-hidden />
                      {t(language, "media.crop")}
                    </Button>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </SectionCard>
    </div>
  );
}

function mediaFilterLabel(language: ReturnType<typeof usePreferences>["language"], value: MediaFilter): string {
  switch (value) {
    case "all":
      return t(language, "media.filter.all");
    case "product":
      return t(language, "media.filter.product");
    case "brand":
      return t(language, "media.filter.brand");
    case "content":
      return t(language, "media.filter.content");
  }
}
