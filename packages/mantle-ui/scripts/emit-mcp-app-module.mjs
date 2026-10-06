#!/usr/bin/env node
// Wrap the single-file MCP App as an ES module, so any bundler or Worker can
// import the HTML as a string without an asset loader.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "../dist/mcp-app");
const html = readFileSync(resolve(dir, "interaction.html"), "utf8");
const doc = `/**
 * The Mantle MCP App, one self-contained HTML document. Give it to \`planApp\`
 * from \`@aotter/mantle/mcp\`, which embeds the plan's catalog of Views and row
 * actions: \`apps: { resources: [planApp(plan, { surface: "staff", html: mantleAppHtml })] }\`.
 */`;
writeFileSync(resolve(dir, "index.js"), `${doc}\nexport const mantleAppHtml = ${JSON.stringify(html)};\n`);
writeFileSync(resolve(dir, "index.d.ts"), `${doc}\nexport declare const mantleAppHtml: string;\n`);
console.log("mcp-app module written");
