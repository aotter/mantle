import { afterEach, expect, test, vi } from "vitest";
import { downloadAdminFile } from "./api";

afterEach(() => vi.unstubAllGlobals());

test("live exports retain native streaming; preview failures and foreign URLs never navigate", async () => {
  const assign = vi.fn();
  const fetch = vi.fn(async () => new Response("Denied", {status:401}));
  vi.stubGlobal("window", {location:{href:"https://site.test/admin",origin:"https://site.test",assign}});
  vi.stubGlobal("document", {querySelector: () => null});
  vi.stubGlobal("fetch", fetch);
  await downloadAdminFile("/admin/api/entries/export?collection=items");
  expect(assign).toHaveBeenCalledExactlyOnceWith("https://site.test/admin/api/entries/export?collection=items");
  expect(fetch).not.toHaveBeenCalled();
  assign.mockClear();
  vi.stubGlobal("document", {querySelector: () => ({getAttribute: () => "1"})});
  await expect(downloadAdminFile("/admin/api/entries/export")).rejects.toMatchObject({status:401});
  await expect(downloadAdminFile("https://other.test/admin/api/entries/export")).rejects.toThrow("Admin download URL");
  await expect(downloadAdminFile("/oauth/consents/revoke")).rejects.toThrow("Admin download URL");
  expect(assign).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
});
