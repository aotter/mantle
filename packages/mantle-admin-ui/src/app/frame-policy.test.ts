import { expect, test } from "vitest";
import { canRenderAdmin } from "./frame-policy";

test("only explicit preview assets with a same-origin top-level sandbox bridge can render in a frame", () => {
  const fetch = async () => new Response();
  const top = { location: { origin: "https://builder.test" } };
  const frame = { self: {}, parent: top, top, location: top.location, fetch, __MANTLE_ADMIN_PREVIEW__: { fetch } } as unknown as Window;
  expect(canRenderAdmin(frame, true)).toBe(true);
  expect(canRenderAdmin(frame, false)).toBe(false);
  expect(canRenderAdmin({ ...frame, self: top } as unknown as Window, true)).toBe(false);
  expect(canRenderAdmin({ ...frame, self: top } as unknown as Window, false)).toBe(true);
  expect(canRenderAdmin({ ...frame, parent: {} } as Window, true)).toBe(false);
  expect(canRenderAdmin({ ...frame, location: { origin: "https://other.test" } } as Window, true)).toBe(false);
  expect(canRenderAdmin({ ...frame, __MANTLE_ADMIN_PREVIEW__: undefined }, true)).toBe(false);
  expect(canRenderAdmin({ ...frame, fetch: async () => new Response() }, true)).toBe(false);
  const foreign = { ...frame, get parent(): Window { throw new DOMException("Cross-origin", "SecurityError"); } };
  expect(canRenderAdmin(foreign, true)).toBe(false);
});
