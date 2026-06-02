export interface MediaAsset {
  readonly name: string;
  readonly type: string;
  readonly tag: "product" | "brand" | "content";
  readonly alt: string;
  readonly url: string;
  readonly size: string;
  readonly createdAt: string;
  readonly tone: string;
}

export const MEDIA_ASSETS: ReadonlyArray<MediaAsset> = [
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
