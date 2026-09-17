import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button, Card, CardContent, Input } from "../src/kit";
import { AuthPage, LegalNotice } from "../recipes/auth-page";

describe("Mantle UI kit", () => {
  it("renders the shared shadcn primitives without an Admin runtime", () => {
    const html = renderToStaticMarkup(
      <Card><CardContent><Input aria-label="Email" /><Button>Continue</Button></CardContent></Card>,
    );
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('data-slot="input"');
    expect(html).toContain('data-slot="button"');
  });

  it("renders only the legal links supplied by the host application", () => {
    const privacy = renderToStaticMarkup(<LegalNotice legal={{ privacy: "/privacy" }} />);
    expect(privacy).toContain("Privacy Policy");
    expect(privacy).not.toContain("Terms of Use");
    expect(renderToStaticMarkup(<AuthPage legal={{ terms: "/terms" }} onSendCode={async () => {}} onVerifyCode={async () => {}} />))
      .toContain("Terms of Use");
  });
});
