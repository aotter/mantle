import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { mountServerEndpoints } from "../src/mount/mountServerEndpoints.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";

/**
 * End-to-end form submission flow: HTTP Trigger → builtin Procedure
 * (op: create) → projection + x-mantle-bind stamping → entry-writer
 * chokepoint → before_create CAPTCHA hook → write → after_create
 * Slack hook. Validates the full lifecycle + builtin arc end-to-end
 * through the Cloudflare adapter mount layer.
 */
function manifests(): Manifest[] {
  const apiVersion = "cms.mantle.aotter.net/v1" as const;
  return [
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "contact-messages" },
      spec: {
        title: "Contact Messages",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            message: { type: "string" },
            createdAt: { type: "number", "x-mantle-bind": "now" },
          },
          required: ["name", "message"],
        },
        lifecycle: "publishing",
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "submit-contact" },
      spec: {
        input: {
          type: "object",
          properties: {
            name: { type: "string" },
            message: { type: "string" },
            recaptchaToken: { type: "string" },
          },
          required: ["name", "message", "recaptchaToken"],
        },
        output: { type: "object" },
        handler: { kind: "builtin", op: "create", schema: "contact-messages" },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "captcha-check" },
      spec: {
        input: {
          type: "object",
          properties: { recaptchaToken: { type: "string" } },
        },
        output: { type: "object" },
        handler: { kind: "ref", ref: "captchaCheck" },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "slack-notify" },
      spec: {
        input: {
          type: "object",
          properties: { name: { type: "string" }, message: { type: "string" } },
        },
        output: { type: "object" },
        handler: { kind: "ref", ref: "slackNotify" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "submit-contact-http" },
      spec: {
        source: { kind: "http", method: "POST", path: "/api/contact" },
        target: { procedure: "submit-contact" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "010-captcha-guard" },
      spec: {
        source: {
          kind: "lifecycle",
          schema: "contact-messages",
          on: ["before_create"],
          errorPolicy: "abort",
        },
        target: { procedure: "captcha-check" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "020-slack-notify" },
      spec: {
        source: {
          kind: "lifecycle",
          schema: "contact-messages",
          on: ["after_create"],
        },
        target: { procedure: "slack-notify" },
      },
    },
  ];
}

interface Harness {
  app: Hono;
  db: InMemoryDatabase;
  captchaCalls: Array<unknown>;
  slackCalls: Array<unknown>;
}

function harness(opts: { captchaPasses: boolean }): Harness {
  const db = new InMemoryDatabase();
  const captchaCalls: Array<unknown> = [];
  const slackCalls: Array<unknown> = [];
  const ref = createCmsRef({
    manifests: manifests(),
    handlers: {
      captchaCheck: (input) => {
        captchaCalls.push(input);
        if (!opts.captchaPasses) throw new Error("captcha failed");
        return { ok: true };
      },
      slackNotify: (input) => {
        slackCalls.push(input);
        return { ok: true };
      },
    },
    bindings: {
      db,
      adminAssets: new StubAssetServer(),
    },
    auth: stubAuth,
  });
  const app = new Hono();
  mountServerEndpoints(app, ref);
  return { app, db, captchaCalls, slackCalls };
}

describe("smoke: HTTP Trigger → builtin → lifecycle hooks", () => {
  it("rejects malformed JSON before invoking the Procedure", async () => {
    const h = harness({ captchaPasses: true });
    const res = await h.app.request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      diagnostic: { code: "INPUT_VALIDATION_FAILED" },
    });
    expect(h.captchaCalls).toHaveLength(0);
    expect(h.slackCalls).toHaveLength(0);
    expect(h.db.entries.size).toBe(0);
  });

  it("happy path: CAPTCHA passes, row written, Slack fires", async () => {
    const h = harness({ captchaPasses: true });
    const res = await h.app.request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Alice",
        message: "Hi there",
        recaptchaToken: "tok-pass",
      }),
    });
    expect(res.status).toBe(200);
    expect(h.captchaCalls).toHaveLength(1);
    expect(h.slackCalls).toHaveLength(1);
    expect((h.captchaCalls[0] as { recaptchaToken: string }).recaptchaToken).toBe("tok-pass");
    expect(h.db.entries.size).toBe(1);
    const entry = [...h.db.entries.values()][0]!;
    expect(entry.collection).toBe("contact-messages");
    expect(entry.status).toBe("draft");
    const data = JSON.parse(entry.data) as Record<string, unknown>;
    expect(data["name"]).toBe("Alice");
    expect(data["message"]).toBe("Hi there");
    expect(data["createdAt"]).toEqual(expect.any(Number));
    expect("recaptchaToken" in data).toBe(false);
  });

  it("CAPTCHA fails: row not written, Slack does NOT fire", async () => {
    const h = harness({ captchaPasses: false });
    const res = await h.app.request("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bob",
        message: "spam",
        recaptchaToken: "tok-fail",
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.captchaCalls).toHaveLength(1);
    expect(h.slackCalls).toHaveLength(0);
    expect(h.db.entries.size).toBe(0);
  });

  it("rides on c.executionCtx.waitUntil for after-hooks when present", async () => {
    const h = harness({ captchaPasses: true });
    const captured: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => captured.push(p),
      passThroughOnException: () => undefined,
    };
    const res = await h.app.request(
      "/api/contact",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Carol",
          message: "with waitUntil",
          recaptchaToken: "tok-pass",
        }),
      },
      undefined,
      executionCtx,
    );
    expect(res.status).toBe(200);
    // After-hook ran (Slack notify); when waitUntil is available the
    // mount layer hands the after-hook promise to it.
    expect(captured.length).toBeGreaterThan(0);
    await Promise.all(captured);
    expect(h.slackCalls).toHaveLength(1);
  });

});
