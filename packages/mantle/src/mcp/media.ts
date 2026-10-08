/** Optional staff product tools over the same library Admin uses; media bytes never enter MCP. */
import type { MediaLibrary, MantleSite } from "../core/index.js";
import { jsonSchemaToZod, safeParseJson, firstZodIssueAsJsonPointer, type AuthorizationRequirements, type JsonSchema, type McpTool } from "../spec/domain/index.js";
import { DiagnosticError, makeDiagnostic } from "../spec/kernel/index.js";

export type MediaMcpTool = Omit<McpTool, "kind"> & { readonly kind: "media"; readonly run: (input: Record<string, unknown>) => Promise<unknown> };
const requires: AuthorizationRequirements = { auth: { all: [{ "ctx.staff": ["owner", "editor"] }] } };
const string = { type: "string" } as const;
const texts = { alt: { type: "string", maxLength: 1000 }, caption: { type: "string", maxLength: 1000 } };
const input = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

export function mediaTools(library: MediaLibrary, site: MantleSite): MediaMcpTool[] {
  const tool = (name: string, description: string, inputSchema: JsonSchema, invoke: MediaMcpTool["run"], readOnlyHint = false): MediaMcpTool => {
    const schema = jsonSchemaToZod(inputSchema);
    return {
      name, source: name, kind: "media", requires, description, inputSchema,
      run: async (args) => {
        const parsed = safeParseJson(schema, args);
        if (!parsed.success) {
          const { instancePath, message } = firstZodIssueAsJsonPointer(parsed.error);
          throw new DiagnosticError(makeDiagnostic({ code: "INPUT_VALIDATION_FAILED", phase: "runtime", severity: "error", path: `MCP ${name}#/input${instancePath}`, expected: message }));
        }
        return invoke(parsed.data as Record<string, unknown>);
      },
      annotations: { readOnlyHint, destructiveHint: name === "delete_media_asset", openWorldHint: true },
    };
  };
  return [
    tool("get_media_upload_policy", "Read declared image purpose MIME slots and byte caps before preparing variants or requesting an upload. Optimization runs locally, never in the host.", input({}), async () => ({ purposes: (await site.read()).media?.purposes ?? [] }), true),
    tool("create_media_upload", "Create short-lived PUT capabilities for image variants. Read site media purpose policy first; optimize images locally. Obtain attachment bytes yourself, then PUT each variant with its requiredHeaders and call commit_media_upload. Never store upload URLs as published images or ask the user to run terminal commands.", input({ filename: { type: "string", maxLength: 255 }, purpose: string, variants: { type: "array", minItems: 1, items: input({ mimeType: string, byteSize: { type: "integer", minimum: 1 }, role: { type: "string", enum: ["primary", "alternate", "fallback"] } }, ["mimeType", "byteSize", "role"]) }, ...texts }, ["filename", "purpose", "variants"]), (args) => library.createUpload(args)),
    tool("commit_media_upload", "Verify all uploaded variants and commit one permanent media asset. Store the returned asset id in fields referencing media_assets.id, never a temporary upload URL. Unknown or expired upload groups require a new create_media_upload.", input({ uploadGroupId: string, ...texts }, ["uploadGroupId"]), ({ uploadGroupId, ...patch }) => library.commitUpload(uploadGroupId as string, patch)),
    tool("list_media_assets", "List committed image assets, newest first, with their permanent variants and alt/caption. Search matches id, alt or caption; reuse only a returned cursor.", input({ limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: string, search: string }), (args) => library.list(args), true),
    tool("get_media_asset", "Read one committed media asset and its permanent variant URLs.", input({ id: string }, ["id"]), ({ id }) => library.get(id as string), true),
    tool("update_media_asset", "Update committed asset alt or caption; omitted fields remain unchanged and empty strings clear text.", input({ id: string, ...texts }, ["id"]), ({ id, ...patch }) => library.update(id as string, patch)),
    tool("delete_media_asset", "Delete an asset's objects and library record. Check application references first. A partial failure can be retried using the same id.", input({ id: string }, ["id"]), ({ id }) => library.delete(id as string)),
  ];
}
