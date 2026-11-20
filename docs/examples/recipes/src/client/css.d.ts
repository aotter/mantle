// Lets TypeScript accept the stylesheet import in page.ts; `mantle bundle` builds it to /assets/client/page.css and a
// content-hashed copy, which the pages link (src/pages.tsx).
declare module "*.css";
