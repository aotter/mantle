import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChangeDiff,
  createInteractionController,
  EntityPreview,
  OperationPanel,
  OperationStatus,
  type InteractionController,
  type InvokeOutcome,
} from "../src/index.js";

const row = { id: "r1", version: 3, requestStatus: "submitted" };
const interaction = { bind: [{ input: "id", field: "id" }], version: "expectedVersion" } as const;

function controller(overrides: Partial<Parameters<typeof createInteractionController>[0]> = {}): InteractionController {
  return createInteractionController({
    interaction,
    row,
    read: async () => ({ id: "r1", version: 3, data: row }),
    invoke: async (): Promise<InvokeOutcome> => ({ ok: true, data: {} }),
    ...overrides,
  });
}

describe("@aotter/mantle-ui components", () => {
  it("renders the panel with bound inputs, the host's fields and a disabled Run until ready", () => {
    const html = renderToStaticMarkup(
      <OperationPanel controller={controller()} title="Review requisition" previewFields={["requestStatus"]}>
        <label>Note <input name="note" /></label>
      </OperationPanel>,
    );
    expect(html).toContain("Review requisition");
    expect(html).toContain("From the selected row");
    expect(html).toContain('name="note"');
    expect(html).toContain("submitted");
    // Submitted from script: MCP hosts often sandbox Apps without `allow-forms`.
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Run<\/button>/u);
    expect(html).not.toContain('type="submit"');
  });

  it("offers no dead re-read after a conflict when the host cannot read", async () => {
    const c = createInteractionController({
      interaction,
      row,
      invoke: async (): Promise<InvokeOutcome> => ({ ok: false, diagnostics: [{ code: "CONFLICT", message: "Moved." }] }),
    });
    await c.open();
    await c.submit();
    const html = renderToStaticMarkup(<OperationStatus controller={c} state={c.getSnapshot()} />);
    expect(html).toContain('data-phase="conflict"');
    expect(html).toContain("open the action again");
    expect(html).not.toContain("Load latest version");
  });

  it("explains a newer version and offers only the review action", async () => {
    const c = controller({ read: async () => ({ id: "r1", version: 4, data: { ...row, requestStatus: "approved" } }) });
    await c.open();
    const html = renderToStaticMarkup(<OperationStatus controller={c} state={c.getSnapshot()} />);
    expect(html).toContain('data-phase="changedSinceList"');
    expect(html).toContain("Review newer version");
    expect(html).toContain("approved");
  });

  it("offers acknowledgement for an uncertain write only when the host cannot read", async () => {
    const failing = async (): Promise<InvokeOutcome> => { throw new Error("timeout"); };
    const withRead = controller({ invoke: failing });
    await withRead.open();
    await withRead.submit();
    expect(renderToStaticMarkup(<OperationStatus controller={withRead} state={withRead.getSnapshot()} />)).toContain("Load latest version");
    const blind = createInteractionController({ interaction, row, invoke: failing });
    await blind.open();
    await blind.submit();
    expect(renderToStaticMarkup(<OperationStatus controller={blind} state={blind.getSnapshot()} />)).toContain("I checked; continue");
  });

  it("shows runtime diagnostics as the person-facing reason", async () => {
    const c = controller({ invoke: async () => ({ ok: false, diagnostics: [{ code: "AUTH_DENIED", message: "Only owners can approve." }] }) });
    await c.open();
    await c.submit();
    const html = renderToStaticMarkup(<OperationStatus controller={c} state={c.getSnapshot()} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Only owners can approve.");
  });

  it("renders a diff and an entity preview with host labels", () => {
    const diff = renderToStaticMarkup(<ChangeDiff changes={[{ field: "note", before: "", after: "Ok" }]} fieldLabel={() => "Reviewer note"} />);
    expect(diff).toContain("Reviewer note");
    expect(diff).toContain("—");
    const preview = renderToStaticMarkup(<EntityPreview entry={{ id: "r1", version: 3, data: { title: "Laptops" } }} />);
    expect(preview).toContain("Laptops");
    expect(preview).toContain("Version");
  });
});
