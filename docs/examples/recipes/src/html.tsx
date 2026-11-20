/**
 * The visitor pages as HTML documents. src/routes.ts reaches this module only through `import()`, so react-dom/server
 * and the page components load when a page route matches and never join the Worker's startup graph: `.md`, llms.txt,
 * the sitemap, REST, MCP and Admin do not pay for React. AGENT: keep it that way; import nothing from here statically.
 */
import type { ComponentProps, ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { ListPage, RecipePage } from "./pages.js";

/** `tags` are web().head()'s tags for the page (canonical, Markdown alternate), already escaped HTML. */
const html = (page: ReactElement, tags = "") => "<!doctype html>" + renderToString(page).replace("</head>", () => tags + "</head>");

export const listHtml = (props: ComponentProps<typeof ListPage>) => html(<ListPage {...props} />);
export const recipeHtml = (props: ComponentProps<typeof RecipePage>, tags: string) => html(<RecipePage {...props} />, tags);
