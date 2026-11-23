/** Required application seam `host-tools` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { useEffect } from "react";
import { useHost } from "@aotter/mantle-admin/hooks";

export function useSeamTool(): void {
  const host = useHost();
  useEffect(
    () =>
      host?.registerTools([
        {
          name: "seam_tool",
          description: "A tool.",
          inputSchema: { type: "object", additionalProperties: false },
          handler: () => "ok",
        },
      ]),
    [host],
  );
}
