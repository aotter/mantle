import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GateLoading } from "../src/features/auth/gate-views";

it("loads behind a neutral, busy page frame, not the sign-in card (#1943)", () => {
  const html = renderToStaticMarkup(<GateLoading />);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toMatch(/auth-card|data-slot="card"|theme/i);
});
