/**
 * An application-owned MCP App renderer: the official `App`, the
 * framework-free controller and your own markup, over the catalog `planApp`
 * embeds. Type-checked with the package.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import {
  createInteractionController,
  type InteractionBinding,
  type InteractionDiagnostic,
  type InteractionState,
  type InvokeOutcome,
} from "@aotter/mantle-ui/controller";

/** What `planApp` (`@aotter/mantle/mcp`) embeds in the App's HTML: each View tool's row actions, by Procedure tool name. */
interface Catalog {
  readonly views: Readonly<Record<string, { readonly actions: readonly string[] }>>;
  readonly actions: Readonly<Record<string, InteractionBinding & { readonly capability: string }>>;
}
const catalog = JSON.parse(document.getElementById("mantle-catalog")?.textContent ?? '{"views":{},"actions":{}}') as Catalog;
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
  // a result planApp renders names the View tool it came from
  const tool = result._meta?.["net.aotter.mantle/tool"];
  const rows = ((result.structuredContent as { rows?: Record<string, unknown>[] } | undefined)?.rows) ?? [];
  const [row] = rows;
  const name = typeof tool === "string" ? catalog.views[tool]?.actions[0] : undefined;
  const action = name ? catalog.actions[name] : undefined;
  if (!row || !action) return;
  const controller = createInteractionController({
    interaction: action,
    // the row as listed is what the person reviews; a version that moved since is the server's CONFLICT
    row,
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
