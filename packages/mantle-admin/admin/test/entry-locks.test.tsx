import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@aotter/mantle-ui/kit";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { canEditEntry, EntryEditView } from "../src/features/content/entry-edit-view";
import { OperationDiagnostic } from "../src/features/ops/interaction-dialog";
import { entryEditorQueryOptions } from "../src/lib/queries";
import { declaredLock, type EntryEditorPayload, type EntryLocks } from "../src/lib/types";

const message = "This revision is live. Create a new revision and switch to it.";
/** The editor as an admin sees a cached payload: its notice and its action bar's buttons. */
function editor(lifecycle: "operational" | "publishing", locks?: EntryLocks, status = "draft", schema: object = {}, data: object = { body: "Hello" }): string {
  const client = new QueryClient();
  client.setQueryData(["me"], { admin: true });
  client.setQueryData(entryEditorQueryOptions("revisions", "r1").queryKey, {
    entry: { id: "r1", collection: "revisions", version: 3, status, locale: null, data, ...(locks ? { locks } : {}) },
    collection: { name: "revisions", lifecycle, schema: { type: "object", properties: { body: { type: "string" } }, ...schema } },
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
  const live = { lock: "live_revision", message }, held = { update: live, delete: live };

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

describe("publishing entries and liveEdits (#1822)", () => {
  const drafts = { lock: "publishing", message: "Only drafts may be edited." }, unpublish = { lock: "publishing", message: "Published entries must be unpublished before deletion." };
  const published = { update: drafts, delete: unpublish };

  it("keeps a published entry read-only by default, with Unpublish, since the implicit lock binds no transition", () => {
    const html = editor("publishing", published, "published");
    expect(html).toContain("Published entries are read-only. Unpublish to edit.");
    expect(html).not.toContain("This record is locked");
    expect(button(html, "Unpublish")).not.toMatch(/disabled=""/);
    expect(button(html, "Save")).toBeUndefined();
  });

  it("edits a published entry in place under liveEdits, saying the change goes live", () => {
    const html = editor("publishing", { update: false, delete: unpublish }, "published");
    expect(html).toContain("This entry is published: your changes go live as soon as you save.");
    expect(html).not.toMatch(/<fieldset disabled=""/);
    expect(button(html, "Save")).toBeDefined();
    expect(button(html, "Unpublish")).not.toMatch(/disabled=""/);
  });

  it("disables a live edit's Save while a required field is missing", () => {
    const html = editor("publishing", { update: false, delete: unpublish }, "published", { required: ["body"] }, {});
    expect(html).toContain("go live");
    expect(button(html, "Save")).toMatch(/disabled=""/);
    expect(button(html, "Save")).toContain("complete its required fields to save");
  });

  it("keeps an archived entry read-only under liveEdits, since the server locks it", () => {
    const html = editor("publishing", { update: drafts, delete: false }, "archived");
    expect(html).toContain("Archived entries are read-only.");
    expect(html).not.toContain("go live");
    expect(button(html, "Save")).toBeUndefined();
  });

  it("lets canEditEntry open a non-draft only under liveEdits, and never past a declared lock", () => {
    const access = (o: Partial<Parameters<typeof canEditEntry>[0]>) => canEditEntry({ admin: true, isReadOnly: false, isOperational: false, isDraft: false, operationalEditUnlocked: false, ...o });
    expect(access({})).toBe(false);
    expect(access({ liveEdits: true })).toBe(true);
    expect(access({ liveEdits: true, rowLocked: true })).toBe(false);
    expect(declaredLock(published)).toBe(false);
    expect(declaredLock({ update: { lock: "live_revision", message: "" }, delete: false })).toBe(true);
  });
});
