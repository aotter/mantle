import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@aotter/mantle-ui/kit";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider, createNavigator, guardLeaving, type AdminLocation } from "../src/app/router";
import { ConfirmProvider } from "../src/ui/confirm-dialog";
import { editEntryForm, followEntry, isEntryFormDirty, loadEntryForm, reannounceNewer, settleEntryForm, type EntryForm } from "../src/features/content/entry-form";
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

  it("shows a dismissed notice again on a CONFLICT, and a newer version than the one dismissed always shows it", () => {
    const dismissed = { ...edit(loaded, { title: "Hello, edited" }), newer: { version: 4, dismissed: true } };
    expect(reannounceNewer(dismissed)?.newer).toEqual({ version: 4, dismissed: false });
    expect(reannounceNewer(loaded)).toBe(loaded);
    // the CONFLICT's re-read of the same version keeps it showing
    const shown = reannounceNewer(dismissed)!;
    expect(followEntry(shown, entry(4, { title: "Changed elsewhere" }))).toBe(shown);
    expect(followEntry(dismissed, entry(5, { title: "Changed again" })).newer).toEqual({ version: 5, dismissed: false });
  });

  it("keeps edits made while the person's own write was in flight, on top of the version it returned", () => {
    const sent = { title: "Hello, edited" };
    const typedMore = edit(loaded, { title: "Hello, edited more" });
    const settled = settleEntryForm(typedMore, sent, entry(4, sent));
    expect(settled).toMatchObject({ data: { title: "Hello, edited more" }, base: { version: 4 }, newer: null });
    expect(isEntryFormDirty(settled)).toBe(true);
    // nothing typed since: the server copy, clean
    expect(settleEntryForm(edit(loaded, sent), sent, entry(4, sent))).toMatchObject({ data: sent, base: { version: 4 } });
    // an unpublish keeps the server's data, so unsaved edits stay and become saveable on the returned draft
    const unpublished = entry(4, { title: "Hello" });
    const kept = settleEntryForm(edit(loaded, sent), unpublished.data, unpublished);
    expect(kept).toMatchObject({ data: sent, base: { version: 4 } });
    expect(isEntryFormDirty(kept)).toBe(true);
  });

  it("adopts a known newer version once the person reverts their edits by hand", () => {
    const newer = entry(4, { title: "Changed elsewhere" });
    const announced = followEntry(edit(loaded, { title: "Hello, edited" }), newer);
    expect(editEntryForm(announced, { title: "Hello" }, newer)).toMatchObject({ data: { title: "Changed elsewhere" }, base: { version: 4 }, newer: null });
    // still dirty: the edit stays on the old base, announced
    expect(editEntryForm(announced, { title: "Hello, more" }, newer)).toMatchObject({ base: { version: 3 }, newer: { version: 4 } });
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
      <PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><TooltipProvider><AdminRouterProvider><ConfirmProvider>
        <EntryEditView collectionName="posts" entryId="e1" />
      </ConfirmProvider></AdminRouterProvider></TooltipProvider></QueryClientProvider></PreferencesProvider>,
    );
    expect(html).toContain("Hello");
    expect(html).toContain("v3");
    expect(html).not.toContain("was saved while you were editing");
  });
});

/** A browser history, enough for the navigator: a traversal moves at once and reports the pop, as a `popstate` would. */
function fakeBrowser(start: string) {
  const stack: { url: string; state: unknown }[] = [{ url: start, state: null }];
  let index = 0;
  const url = () => new URL(stack[index]!.url, "https://site.test");
  const browser = {
    onPop: () => {},
    location: { get href() { return url().href; }, get pathname() { return url().pathname; }, get search() { return url().search; }, get hash() { return url().hash; } },
    history: {
      get state() { return stack[index]!.state; },
      pushState: (state: unknown, _title: string, next: string) => { stack.splice(++index, stack.length, { url: next, state }); },
      replaceState: (state: unknown, _title: string, next?: string) => { stack[index] = { url: next ?? stack[index]!.url, state }; },
      go: (delta: number) => { index += delta; browser.onPop(); },
      back: () => browser.history.go(-1),
      forward: () => browser.history.go(1),
    },
    /** A same-page `#hash` link the browser follows itself: a new entry with no state. */
    hash: (hash: string) => { const next = `${url().pathname}${url().search}${hash}`; stack.splice(++index, stack.length, { url: next, state: null }); browser.onPop(); },
    get path() { return stack[index]!.url; },
    get urls() { return stack.map((entry) => entry.url); },
  };
  return browser;
}

describe("leaving a record form with unsaved changes (#1792)", () => {
  const setup = (start = "/admin/c/posts/e1") => {
    const browser = fakeBrowser(start);
    const shown: AdminLocation[] = [];
    const navigator = createNavigator(browser as unknown as Window, (location) => shown.push(location));
    browser.onPop = navigator.popped;
    navigator.start();
    const win = new EventTarget();
    return { browser, shown, navigator, win };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const beforeUnload = (win: EventTarget) => { const event = new Event("beforeunload", { cancelable: true }); win.dispatchEvent(event); return event.defaultPrevented; };
  const guard = (setup: { navigator: ReturnType<typeof createNavigator>; win: EventTarget }, ask: () => Promise<boolean>) => guardLeaving(setup.win as unknown as Window, setup.navigator.block, ask);

  it("is active only while the form is dirty, and Save or Load latest version clears it", () => {
    const loaded = loadEntryForm(entry(3, { title: "Hello" }));
    const dirty = editEntryForm(loaded, { title: "Hello, edited" }, undefined);
    expect([isEntryFormDirty(loaded), isEntryFormDirty(dirty)]).toEqual([false, true]);
    // Save: the server copy of what was sent; Load latest version: the newer server copy
    expect(isEntryFormDirty(settleEntryForm(dirty, dirty.data, entry(4, dirty.data)))).toBe(false);
    expect(isEntryFormDirty(loadEntryForm(entry(4, { title: "Changed elsewhere" })))).toBe(false);
  });

  it("navigates freely without a guard, and the browser's prompt shows only while one is held", async () => {
    const page = setup();
    const { browser, shown, navigator, win } = page;
    expect(await navigator.navigate("/admin/c/posts")).toBe(true);
    expect(browser.path).toBe("/admin/c/posts");
    expect(shown).toEqual([{ pathname: "/admin/c/posts", search: "" }]);
    expect(beforeUnload(win)).toBe(false);
    const release = guard(page, async () => false);
    expect(beforeUnload(win)).toBe(true);
    release();
    expect(beforeUnload(win)).toBe(false);
    const ask = vi.fn(async () => true);
    guard(page, ask)();
    await navigator.navigate("/admin");
    expect(ask).not.toHaveBeenCalled();
    expect(browser.path).toBe("/admin");
  });

  it("asks before Admin's own navigation: staying keeps the page, confirming proceeds", async () => {
    const page = setup();
    const { browser, shown, navigator } = page;
    const answers = [false, true];
    const ask = vi.fn(async () => answers.shift()!);
    const release = guard(page, ask);
    expect(await navigator.navigate("/admin/c/posts")).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(browser.path).toBe("/admin/c/posts/e1");
    expect(shown).toEqual([]);
    expect(await navigator.navigate("/admin/c/posts")).toBe(true);
    expect(browser.path).toBe("/admin/c/posts");
    expect(shown).toEqual([{ pathname: "/admin/c/posts", search: "" }]);
    // the same page, or another hash of it, is not leaving
    await navigator.navigate("/admin/c/posts#content");
    expect(ask).toHaveBeenCalledTimes(2);
    release();
  });

  it("lets a hash change through, and Back across it", async () => {
    const page = setup();
    const ask = vi.fn(async () => false);
    guard(page, ask);
    page.browser.hash("#content");
    page.browser.history.back();
    await tick();
    expect(ask).not.toHaveBeenCalled();
    expect(page.browser.path).toBe("/admin/c/posts/e1");
  });

  it("undoes a cancelled Back or Forward with the history intact, and confirming lands on the chosen entry", async () => {
    const page = setup("/admin/a");
    const { browser, navigator } = page;
    await navigator.navigate("/admin/c/posts/e1");
    await navigator.navigate("/admin/c");
    browser.history.back(); // on the record form, with /admin/c ahead
    expect(browser.urls).toEqual(["/admin/a", "/admin/c/posts/e1", "/admin/c"]);
    let answer = false;
    const ask = vi.fn(async () => answer);
    guard(page, ask);
    page.shown.length = 0;
    for (const move of [() => browser.history.forward(), () => browser.history.back()]) {
      move();
      await tick();
      expect(browser.urls).toEqual(["/admin/a", "/admin/c/posts/e1", "/admin/c"]);
      expect(browser.path).toBe("/admin/c/posts/e1");
    }
    expect(ask).toHaveBeenCalledTimes(2);
    expect(page.shown).toEqual([]);
    answer = true;
    browser.history.forward();
    await tick();
    expect(browser.path).toBe("/admin/c");
    expect(browser.urls).toEqual(["/admin/a", "/admin/c/posts/e1", "/admin/c"]);
    expect(page.shown).toEqual([{ pathname: "/admin/c", search: "" }]);
  });

  it("lets only the latest of two moves act when the first is still asking", async () => {
    const page = setup("/admin/a");
    const { browser, navigator } = page;
    await navigator.navigate("/admin/c/posts/e1");
    const answers: ((leave: boolean) => void)[] = [];
    guard(page, () => new Promise((resolve) => answers.push(resolve)));
    const first = navigator.navigate("/admin/x");
    const second = navigator.navigate("/admin/y");
    answers[1]!(true);
    answers[0]!(true);
    expect(await second).toBe(true);
    expect(await first).toBe(false);
    expect(browser.path).toBe("/admin/y");
  });
});
