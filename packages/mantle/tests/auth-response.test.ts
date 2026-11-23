import { expect, test } from "bun:test";
import { normalizeEmailOtpResponse } from "../src/auth/routes.js";

test("public OTP failures have one status, body and header set", async () => {
  const snapshots = [];
  for (const [status, code] of [
    [400, "INVALID_OTP"],
    [400, "OTP_EXPIRED"],
    [403, "TOO_MANY_ATTEMPTS"],
  ] as const) {
    const response = await normalizeEmailOtpResponse(
      Response.json(
        { code, message: "upstream detail", extra: "private" },
        {
          status,
          headers: {
            "x-verification-state": code,
            "content-length": "123",
            "set-cookie": "private=value",
            "retry-after": "60",
          },
        },
      ),
    );
    snapshots.push({
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      body: await response.json(),
    });
  }
  expect(snapshots).toEqual(
    Array(3).fill({
      status: 400,
      statusText: "BAD_REQUEST",
      headers: [
        ["cache-control", "private, no-store"],
        ["content-type", "application/json"],
      ],
      body: { code: "INVALID_OTP", message: "Invalid OTP" },
    }),
  );
});

test("success, throttling, protocol errors and non-JSON responses stay untouched", async () => {
  for (const response of [
    Response.json({ success: true }, { headers: { "set-cookie": "session=fixture; HttpOnly" } }),
    Response.json({ code: "TOO_MANY_ATTEMPTS" }, { status: 429, headers: { "retry-after": "60" } }),
    Response.json({ code: "OTP_EXPIRED" }, { status: 500 }),
    Response.json({ error: "invalid_grant" }, { status: 400 }),
    Response.json({ code: "EMAIL_DOMAIN_NOT_ALLOWED" }, { status: 403 }),
    Response.json(null, { status: 400 }),
    Response.json("INVALID_OTP", { status: 400 }),
    new Response('{"code":', { status: 400, headers: { "content-type": "application/json" } }),
    new Response("OTP_EXPIRED", { status: 400, headers: { "content-type": "text/plain" } }),
  ]) {
    const expected = await response.clone().text();
    expect(await normalizeEmailOtpResponse(response)).toBe(response);
    expect(await response.text()).toBe(expected);
  }
});
