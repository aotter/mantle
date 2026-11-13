/**
 * Application seams `own-tools` and `app-resource-meta` (packages/mantle/tests/application-seams.ts): the application's own MCP tool
 * and App resource beside the generated tools. Public imports only, no casts.
 */
import { mcp, withResultMeta, type McpApps, type Tool } from "@aotter/mantle/mcp";
import type { Caller } from "@aotter/mantle/contracts";
import { tools } from "./generated/mcp.js";
import type { Handlers, store } from "./generated/generated.js";

type Db = Parameters<typeof store>[0];

export const noteSummary: Tool<Db, Handlers> = {
  name: "note_summary",
  surface: "public",
  description: "A summary of the caller's notes.",
  inputSchema: { type: "object", additionalProperties: false },
  validate: raw => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("Expected an object.");
    return Object.fromEntries(Object.entries(raw));
  },
  readOnly: true,
  meta: { "example/listing": { kind: "summary" } },
  run: async () => withResultMeta({ notes: 0 }, { "example/view": { compact: true } }),
};

export const summaryApp: McpApps = {
  resources: [
    {
      uri: "ui://notes/summary",
      name: "notes-summary",
      renders: ["note_summary"],
      html: "<!doctype html><title>Notes</title>",
      meta: { "example/host": { border: false } },
    },
  ],
};

export const serveMcp = (db: Db, caller: Caller) =>
  mcp([...tools, noteSummary], { db: () => db, caller: () => caller, apps: { public: summaryApp } });
