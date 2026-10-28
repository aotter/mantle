import { expect, it } from "vitest";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execute, prepareRevisionsExample } from "./fixtures/revisions-example";

it("the documented revision UI binds a frozen preview, switches/rolls back and recovers real OCC and uncertain outcomes", async () => {
  const directory = await prepareRevisionsExample();
  const { buildAdmin } = await import("../dist/build/index.js");
  // Test-only related write uses the public hook to exercise the same shared-cache refresh as another Admin action.
  await writeFile(resolve(directory, "src/browser-test.tsx"), `import * as React from "react";
import definition from "./admin";
import {useOperation} from "../generated/admin-client";
function RelatedWrite() {const change=useOperation("new-revision",{refresh:["revision-preview"]});
return <button onClick={()=>void change.run?.({post:new URLSearchParams(window.location.search).get("post")!})}>Related write</button>;}
export default {...definition,pages:definition.pages.map(page=>({...page,element:<>{page.element}<RelatedWrite/></>}))};`);
  await execute(process.execPath, [resolve(import.meta.dirname, "../node_modules/typescript/bin/tsc"), "--noEmit", "-p", directory], { cwd: directory });
  await buildAdmin({ entry: resolve(directory, "src/browser-test.tsx"), mcpEntry: resolve(directory, "src/admin.mcp.tsx"), outDir: resolve(directory, "dist") });
  const backend = spawn("bun", [resolve(import.meta.dirname, "fixtures/revisions-server.ts"), directory], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; backend.stderr.on("data", chunk => { errors += String(chunk); });
  const ready = await new Promise<{ origin: string; post: string; first: string; second: string }>((done, reject) => {
    const timer = setTimeout(() => reject(Error(`Revision backend timeout: ${errors}`)), 15_000);
    backend.once("exit", code => { clearTimeout(timer); reject(Error(`Revision backend exited ${code}: ${errors}`)); });
    let output = "";
    backend.stdout.on("data", chunk => { output += String(chunk); const line = output.split("\n").find(line => line.startsWith('{"origin":')); if (line) { clearTimeout(timer); done(JSON.parse(line)); } });
  });
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const { origin, post, first, second } = ready;
    const state = async () => await (await fetch(origin + "/test/state")).json() as any;
    const mutate = (path: string) => fetch(origin + "/test/" + path, { method: "POST" });
    const initial = await (await fetch(origin + "/admin/api/entries?collection=posts")).json() as any;
    expect(initial.items.some((item: any) => item.id === post)).toBe(false);
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    await page.addInitScript(() => localStorage.setItem("cms.preference.language", "en"));
    await page.goto(`${origin}/admin/p/revisions?post=${post}`);
    await page.getByRole("heading", { name: "Post: hello", exact: true }).waitFor();
    const revision = page.getByLabel("Revision", { exact: true });
    const preview = page.getByRole("button", { name: "Preview selected revision", exact: true });
    const change = page.getByRole("button", { name: "Switch to reviewed revision", exact: true });
    const frozen = page.getByRole("region", { name: "Frozen revision preview" });
    const view = async (id: string) => { await revision.selectOption(id); await preview.click(); await change.waitFor(); };
    await view(second);
    await frozen.getByText("Candidate body", { exact: true }).waitFor();
    await revision.selectOption(first);
    expect(await frozen.count()).toBe(0); // A new selection cannot keep the previous approval.
    await view(second); await frozen.getByText("Candidate body", { exact: true }).waitFor();
    const reviewed = await state();
    expect(await (await fetch(origin + "/posts/hello")).text()).toContain("Published body");
    expect(await page.getByRole("link", { name: "Edit draft", exact: true }).count()).toBe(1);
    // A real second writer changes the candidate; another Admin mutation refreshes the shared View cache.
    await mutate("edit");
    const refreshed = page.waitForResponse(response => response.url().includes("/admin/api/views/revision-preview") && response.status() === 200);
    await page.getByRole("button", { name: "Related write", exact: true }).click();
    await refreshed;
    await frozen.getByText("Candidate body", { exact: true }).waitFor();
    expect(await frozen.getByText("Changed after preview", { exact: true }).count()).toBe(0);
    await change.click();
    await page.getByRole("alert").filter({ hasText: "changed. Preview again" }).waitFor();
    expect(await change.isDisabled()).toBe(true);
    let current = await state();
    expect(current.writes[0]).toEqual({ post, revision: second, expectedVersion: reviewed.post.version, expectedRevisionVersion: reviewed.second.version });
    expect(current.post.current_revision).toBe(first); expect(Boolean(current.second.sealed)).toBe(false);
    await preview.click(); await frozen.getByText("Changed after preview", { exact: true }).waitFor();
    // A real parent OCC race rolls the candidate seal back as well.
    await mutate("parent"); await change.click();
    await page.getByRole("alert").filter({ hasText: "changed. Preview again" }).waitFor();
    current = await state(); expect(Boolean(current.second.sealed)).toBe(false); expect(current.post.current_revision).toBe(first);
    await preview.click(); await frozen.getByText("Changed after preview", { exact: true }).waitFor();
    const writeCount = (await state()).writes.length;
    await change.evaluate(button => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await page.getByRole("status").filter({ hasText: "Revision selected" }).waitFor();
    expect((await state()).writes.length).toBe(writeCount + 1);
    expect(await (await fetch(origin + "/posts/hello")).text()).toContain("Changed after preview");
    current = await state(); expect(current.post.status).toBe("published"); expect(Boolean(current.second.sealed)).toBe(true);
    // Rollback is the same explicit preview+switch over immutable history.
    await view(first); await frozen.getByText("Published body", { exact: true }).waitFor();
    await change.click(); await page.getByRole("status").filter({ hasText: "Revision selected" }).waitFor();
    expect(await (await fetch(origin + "/posts/hello")).text()).toContain("Published body");
    // The server commits, but the successful response is lost. The page never retries the uncertain write.
    await view(second); await frozen.getByText("Changed after preview", { exact: true }).waitFor();
    await mutate("uncertain"); const before = (await state()).writes.length;
    await change.click(); await page.getByRole("alert").filter({ hasText: "outcome is unconfirmed" }).waitFor();
    expect(await change.isDisabled()).toBe(true);
    current = await state(); expect(current.writes.length).toBe(before + 1); expect(current.post.current_revision).toBe(second);
    await preview.click(); await frozen.getByText(`Selected when previewed: ${second}.`, { exact: true }).waitFor();
    expect(await change.isDisabled()).toBe(true); // Reconciled: this revision is already selected.
    expect((await state()).writes.length).toBe(before + 1);
  } finally {
    await browser.close(); backend.kill("SIGTERM");
    await new Promise<void>(done => { if (backend.exitCode !== null) done(); else backend.once("exit", () => done()); });
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
