/**
 * Application seam `host-tools` (packages/mantle/tests/application-seams.ts): an application page in the Admin MCP App
 * registers its own app tools. Public imports only, no casts.
 */
import { useEffect } from "react";
import { useHost } from "@aotter/mantle-admin/hooks";

/** A page's hook: while the page is shown in a host, the model may ask it for its open note count. */
export function useNoteCountTool(count: number): void {
  const host = useHost();
  useEffect(
    () =>
      host?.registerTools([
        {
          name: "notes_open_count",
          description: "How many notes the page shows.",
          inputSchema: { type: "object", additionalProperties: false },
          annotations: { readOnlyHint: true },
          handler: () => `${count} notes are open.`,
        },
      ]),
    [host, count],
  );
}
