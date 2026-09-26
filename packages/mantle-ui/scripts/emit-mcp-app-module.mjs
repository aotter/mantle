#!/usr/bin/env node
// Wrap the single-file MCP App as an ES module, so any bundler or Worker can
// import the HTML as a string without an asset loader.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "../dist/mcp-app");
const html = readFileSync(resolve(dir, "interaction.html"), "utf8");
writeFileSync(resolve(dir, "index.js"), `/** The Mantle MCP App, one self-contained HTML document. */
export const interactionAppHtml = ${JSON.stringify(html)};

/** Resource URI the App is registered under by default. */
export const INTERACTION_APP_URI = "ui://mantle/interaction";

/**
 * An MCP Apps resource for \`apps.resources\` that renders every View tool
 * and, where the surface has a site renderer, offers the App-only
 * \`preview_entry\`. Override any field, for example \`renders\`.
 */
export function interactionAppResource(overrides = {}) {
  return {
    uri: INTERACTION_APP_URI,
    name: "mantle-interaction",
    title: "Mantle",
    description: "Rows of a Mantle View and the operations they feed.",
    html: interactionAppHtml,
    renders: (capability) => capability.route?.kind === "view",
    appOnly: ["preview_entry"],
    ...overrides,
  };
}
`);
writeFileSync(resolve(dir, "index.d.ts"), `/** The Mantle MCP App, one self-contained HTML document. */
export declare const interactionAppHtml: string;
/** Resource URI the App is registered under by default. */
export declare const INTERACTION_APP_URI = "ui://mantle/interaction";
/** The fields of an \`@aotter/mantle-mcp\` App resource this helper fills. */
export interface InteractionAppResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly html: string | (() => string | Promise<string>);
  readonly renders: (capability: { readonly route: { readonly kind: string }; readonly rowActions?: readonly unknown[] }) => boolean;
  readonly appOnly?: readonly string[];
  readonly [option: string]: unknown;
}
/** An MCP Apps resource that renders every View tool and offers the App-only site preview. */
export declare function interactionAppResource(overrides?: Partial<InteractionAppResource>): InteractionAppResource;
`);
console.log("mcp-app module written");
