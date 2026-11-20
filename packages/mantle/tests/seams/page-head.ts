/** Required application seam `page-head` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { pageHead, type PageHeadOptions } from "@aotter/mantle/web";

const options: PageHeadOptions = {
  title: "Seam",
  description: "Seam",
  url: "https://seam.example/a",
  locale: "en",
  alternates: { en: "https://seam.example/a" },
  xDefault: "https://seam.example/a",
  jsonLd: { "@type": "Thing" },
};
export const head = pageHead(options);
