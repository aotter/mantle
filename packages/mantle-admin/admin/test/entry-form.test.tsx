import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@aotter/mantle-ui/kit";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { followEntry, isEntryFormDirty, loadEntryForm, type EntryForm } from "../src/features/content/entry-form";
import { EntryEditView, NewerVersionNotice } from "../src/features/content/entry-edit-view";
import { entryEditorQueryOptions } from "../src/lib/queries";
import type { EntryEditorPayload } from "../src/lib/types";

const entry = (version: number, data: Record<string, unknown>) => ({ id: "e1", collection: "posts", version, data });
const edit = (form: EntryForm, data: Record<string, unknown>): EntryForm => ({ ...form, data });

describe("the record form against an editor re-read (#1790)", () => {
  const loaded = loadEntryForm(entry(3, { title: "Hello" }));

  it("keeps a dirty form's edit when a re-read brings the same version (related sections or metadata moved)", () => {
    const dirty = edit(loaded, { title: "Hello, edited" });
    const next = followEntry(dirty, entry(3, { title: "Hello" }));
    expect(next.data).toEqual({ title: "Hello, edited" });
    expect(next.base.version).toBe(3);
    expect(next.newer).toBeNull();
    expect(isEntryFormDirty(next)).toBe(true);
  });

  it("keeps a dirty form's edit against a newer version, announces it, and Save keeps the version it was loaded from", () => {
    const dirty = edit(loaded, { title: "Hello, edited" });
    const next = followEntry(dirty, entry(4, { title: "Changed elsewhere" }));
    expect(next.data).toEqual({ title: "Hello, edited" });
    expect(next.newer).toEqual({ version: 4, dismissed: false });
    // dirty still compares against the base the form was loaded from; Save sends its version and meets the CONFLICT
    expect(next.base).toMatchObject({ version: 3, data: { title: "Hello" } });
    expect(isEntryFormDirty(next)).toBe(true);
    // a further re-read of the same newer version keeps a dismissed notice dismissed
    const kept = { ...next, newer: { version: 4, dismissed: true } };
    expect(followEntry(kept, entry(4, { title: "Changed elsewhere" }))).toBe(kept);
    // "Load latest version" discards the edit and adopts the server copy
    const reloaded = loadEntryForm(entry(4, { title: "Changed elsewhere" }));
    expect(reloaded).toMatchObject({ data: { title: "Changed elsewhere" }, base: { version: 4 }, newer: null });
    expect(isEntryFormDirty(reloaded)).toBe(false);
  });

  it("adopts a newer version silently when the form is clean", () => {
    const next = followEntry(loaded, entry(4, { title: "Changed elsewhere" }));
    expect(next).toMatchObject({ data: { title: "Changed elsewhere" }, base: { version: 4 }, newer: null });
  });

  it("takes the server copy after the person's own save, with no notice when the payload is then re-read", () => {
    const saved = entry(4, { title: "Saved by me" });
    const afterSave = loadEntryForm(saved); // syncPayload
    const afterRead = followEntry(afterSave, saved); // the query data it set, then any later re-read
    expect(afterRead).toMatchObject({ data: { title: "Saved by me" }, base: { version: 4 }, newer: null });
    expect(isEntryFormDirty(afterRead)).toBe(false);
  });

  it("starts over on another entry rather than carrying edits across", () => {
    const dirty = edit(loaded, { title: "Hello, edited" });
    const other = followEntry(dirty, { ...entry(9, { title: "Other" }), id: "e2" });
    expect(other).toMatchObject({ data: { title: "Other" }, newer: null });
  });

  it("renders the notice with its reload and keep-editing actions", () => {
    const html = renderToStaticMarkup(
      <PreferencesProvider initialLanguage="en"><NewerVersionNotice language="en" version="4" onReload={() => {}} onKeepEditing={() => {}} /></PreferencesProvider>,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("A newer version (v4) was saved while you were editing.");
    expect(html).toContain("Load latest version");
    expect(html).toContain("Keep editing");
  });

  it("renders the form from a cached payload on the first render, without the notice", () => {
    const client = new QueryClient();
    const payload = {
      entry: { ...entry(3, { title: "Hello" }), status: "draft", locale: null },
      collection: { name: "posts", lifecycle: "publishing", schema: { type: "object", properties: { title: { type: "string" } } } },
      related: [],
      parentEntryId: null,
    } as unknown as EntryEditorPayload;
    client.setQueryData(entryEditorQueryOptions("posts", "e1").queryKey, payload);
    const html = renderToStaticMarkup(
      <PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><TooltipProvider><AdminRouterProvider>
        <EntryEditView collectionName="posts" entryId="e1" />
      </AdminRouterProvider></TooltipProvider></QueryClientProvider></PreferencesProvider>,
    );
    expect(html).toContain("Hello");
    expect(html).toContain("v3");
    expect(html).not.toContain("was saved while you were editing");
  });
});
