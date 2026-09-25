/**
 * An application-owned MCP App renderer: the official `App`, the
 * framework-free controller and your own markup. Quoted in
 * docs/handbook/concepts/mcp-and-agents.md and type-checked with the package.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import {
  createInteractionController,
  type EntrySnapshot,
  type InteractionBinding,
  type InteractionDiagnostic,
  type InteractionState,
  type InvokeOutcome,
} from "@aotter/mantle-ui/controller";

interface Interaction {
  readonly view: string;
  readonly collection: string | null;
  readonly read?: string;
  readonly rowActions: readonly (InteractionBinding & { readonly capability: string; readonly title?: string })[];
}
type CallResult = Awaited<ReturnType<App["callServerTool"]>>;

declare function render(state: InteractionState): void; // your own markup

/** `structuredContent`, else the JSON text block: failures of a tool with an output schema travel as text. */
function output(result: CallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.find((item) => item.type === "text");
  return text && "text" in text ? JSON.parse(text.text) as unknown : undefined;
}

const app = new App({ name: "my-review-app", version: "1.0.0" }, {});
app.ontoolresult = (result) => {
  const meta = result._meta?.["net.aotter.mantle/interaction"] as Interaction | undefined;
  const rows = ((result.structuredContent as { rows?: Record<string, unknown>[] } | undefined)?.rows) ?? [];
  const [row] = rows;
  const [action] = meta?.rowActions ?? [];
  if (!meta || !row || !action) return;
  const reader = meta.read;
  const controller = createInteractionController({
    interaction: action,
    row,
    // Only surfaces with an entry reader name one; otherwise the row is what the person reviews.
    ...(reader ? {
      read: async (signal: AbortSignal) => output(await app.callServerTool(
        { name: reader, arguments: { collection: meta.collection, id: row["id"] } }, { signal })) as EntrySnapshot,
    } : {}),
    invoke: async (input, signal): Promise<InvokeOutcome> => {
      const answer = await app.callServerTool({ name: action.capability, arguments: input }, { signal });
      if (!answer.isError) return { ok: true, data: output(answer) };
      const diagnostics = (output(answer) as { diagnostics?: InteractionDiagnostic[] } | undefined)?.diagnostics;
      // No diagnostics means the outcome is unknown: throw, and the controller never retries it.
      if (!diagnostics?.length) throw new Error("The tool failed without a diagnostic.");
      return { ok: false, diagnostics };
    },
  });
  controller.subscribe(() => render(controller.getSnapshot()));
  void controller.open();
};
await app.connect();
