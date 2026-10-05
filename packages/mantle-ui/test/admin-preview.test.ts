import { expect, it } from "vitest";
import { adminPreviewDocument, readAdminPreviewRequest } from "../src/admin-preview/index.js";

it("prepares only the opt-in asset, and rejects requests outside its Admin bridge", () => {
  expect(() => adminPreviewDocument('<head></head>', { basePath: '/builder/admin', assetBasePath: '/preview' })).toThrow();
  const html = adminPreviewDocument('<head><meta name="mantle-admin-preview" content="1"><script src="/admin/theme.js"></script></head>', { basePath: '/builder/admin', assetBasePath: '/preview', design: true });
  expect(html).toContain('src="/preview/host-bridge.js" data-base-path="/builder/admin" data-mode="design"');
  expect(html).toContain('src="/preview/theme.js"');
  const envelope = { type: 'mantle:host-api:request', protocolVersion: 1, request: { url: 'https://host.test/admin/api/developer-console', method: 'GET', headers: [], body: null } };
  expect(readAdminPreviewRequest(envelope, 'https://host.test').method).toBe('GET');
  for (const url of ['https://foreign.test/admin/api/me', 'https://host.test/api/auth/sign-out', 'https://host.test/admin/api/../sign-in']) {
    expect(() => readAdminPreviewRequest({ ...envelope, request: { ...envelope.request, url } }, 'https://host.test')).toThrow();
  }
  expect(() => readAdminPreviewRequest({ ...envelope, request: { ...envelope.request, body: new ArrayBuffer(1) } }, 'https://host.test')).toThrow();
});
