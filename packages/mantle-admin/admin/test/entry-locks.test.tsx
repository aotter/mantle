import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@aotter/mantle-ui/kit";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { EntryEditView } from "../src/features/content/entry-edit-view";
import { OperationDiagnostic } from "../src/features/ops/interaction-dialog";
import { entryEditorQueryOptions } from "../src/lib/queries";
import type { EntryEditorPayload, EntryLocks } from "../src/lib/types";

const message = "This revision is live. Create a new revision and switch to it.";
/** The editor as an admin sees a cached payload: its notice and its action bar's buttons. */
function editor(lifecycle: "operational" | "publishing", locks?: EntryLocks, status = "draft"): string {
  const client = new QueryClient();
  client.setQueryData(["me"], { admin: true });
  client.setQueryData(entryEditorQueryOptions("revisions", "r1").queryKey, {
    entry: { id: "r1", collection: "revisions", version: 3, status, locale: null, data: { body: "Hello" }, ...(locks ? { locks } : {}) },
    collection: { name: "revisions", lifecycle, schema: { type: "object", properties: { body: { type: "string" } } } },
    related: [],
    parentEntryId: null,
  } as unknown as EntryEditorPayload);
  return renderToStaticMarkup(
    <PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><TooltipProvider><AdminRouterProvider>
      <EntryEditView collectionName="revisions" entryId="r1" />
    </AdminRouterProvider></TooltipProvider></QueryClientProvider></PreferencesProvider>,
  );
}
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`))?.[0];

describe("a row a Schema lock holds (#1822)", () => {
  const held = { update: true, delete: true, lock: "live_revision", message };

  it("shows the lock's message, drops the unlock toggle and disables Save", () => {
    const html = editor("operational", held);
    expect(html).toContain(`This record is locked. ${message}`);
    expect(html).not.toContain("Unlock");
    expect(button(html, "Save")).toMatch(/disabled=""/);
    expect(button(html, "Save")).toContain(`title="This record is locked. ${message}"`);
    expect(html).toMatch(/<fieldset disabled=""/);
  });

  it("disables a publishing entry's form and its transitions, which the lock also refuses", () => {
    const html = editor("publishing", held);
    expect(button(html, "Publish")).toMatch(/disabled=""/);
    expect(button(html, "Save")).toMatch(/disabled=""/);
  });

  it("leaves an unlocked row as before", () => {
    const html = editor("operational", { update: false, delete: false });
    expect(html).not.toContain("This record is locked");
    expect(button(html, "Unlock")).toBeDefined();
  });

  it("explains a lock refusal with its message", () => {
    const html = renderToStaticMarkup(<>{OperationDiagnostic({ diagnostic: { code: "CONFLICT", kind: "lock", message }, language: "en" })}</>);
    expect(html).toBe(`This record is locked and was not changed. ${message}`);
  });
});
