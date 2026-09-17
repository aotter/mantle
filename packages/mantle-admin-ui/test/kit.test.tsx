import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AuthCard, AuthLegalNotice, Button, Card, CardContent, CardHeader, Input } from "../src/kit";

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
    const privacy = renderToStaticMarkup(<AuthLegalNotice legal={{ privacy: "/privacy" }} />);
    expect(privacy).toContain("Privacy Policy");
    expect(privacy).not.toContain("Terms of Use");
    expect(renderToStaticMarkup(<AuthCard action={<button>Theme</button>}><CardHeader>Sign in</CardHeader></AuthCard>))
      .toContain("max-w-sm");
  });
});
