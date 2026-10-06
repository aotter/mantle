import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AuthCard, AuthLegalNotice, Button, Card, CardContent, CardHeader, Input } from "../src/kit/index.js";

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

describe("kit.css", () => {
  it("styles the copy-owned auth page recipe (run `pnpm run build` first)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(import.meta.dirname, "../dist/kit/kit.css"), "utf8");
    const recipe = readFileSync(resolve(import.meta.dirname, "../recipes/auth-page.tsx"), "utf8");
    const classes = [...recipe.matchAll(/className="([^"]+)"/gu)].flatMap(([, list]) => list!.split(/\s+/u));
    const escaped = (name: string) => `.${name.replace(/[:/[\].]/gu, (char) => `\\${char}`)}`;
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.filter((name) => !css.includes(escaped(name)))).toEqual([]);
  });
});
