import { describe, expect, it } from "vitest";
import { TriggerIndex } from "../src/domain/service/TriggerIndex.js";
import { makeHttpTrigger, makeLifecycleTrigger } from "./fakes/manifests.js";

describe("TriggerIndex", () => {
  it("indexes lifecycle Triggers by (schema, hook)", () => {
    const idx = new TriggerIndex([
      makeLifecycleTrigger({
        name: "010-bot-check",
        procedure: "captchaCheck",
        schema: "posts",
        on: ["before_create"],
      }),
      makeLifecycleTrigger({
        name: "020-notify",
        procedure: "slackNotify",
        schema: "posts",
        on: ["after_create"],
      }),
    ]);
    expect(idx.forHook("posts", "before_create")).toHaveLength(1);
    expect(idx.forHook("posts", "after_create")).toHaveLength(1);
    expect(idx.forHook("posts", "before_update")).toEqual([]);
  });

  it("ignores non-lifecycle Triggers", () => {
    const idx = new TriggerIndex([
      makeHttpTrigger({ procedure: "ping", path: "/api/ping" }),
    ]);
    expect(idx.forHook("posts", "before_create")).toEqual([]);
  });

  it("orders Triggers within a (schema, hook) group alphabetically by name", () => {
    const idx = new TriggerIndex([
      makeLifecycleTrigger({
        name: "030-third",
        procedure: "p3",
        schema: "posts",
        on: ["before_create"],
      }),
      makeLifecycleTrigger({
        name: "010-first",
        procedure: "p1",
        schema: "posts",
        on: ["before_create"],
      }),
      makeLifecycleTrigger({
        name: "020-second",
        procedure: "p2",
        schema: "posts",
        on: ["before_create"],
      }),
    ]);
    const names = idx.forHook("posts", "before_create").map((t) => t.metadata.name);
    expect(names).toEqual(["010-first", "020-second", "030-third"]);
  });

  it("supports multiple hooks declared on a single Trigger.on array", () => {
    const idx = new TriggerIndex([
      makeLifecycleTrigger({
        procedure: "audit",
        schema: "posts",
        on: ["before_create", "before_update", "before_delete"],
      }),
    ]);
    expect(idx.forHook("posts", "before_create")).toHaveLength(1);
    expect(idx.forHook("posts", "before_update")).toHaveLength(1);
    expect(idx.forHook("posts", "before_delete")).toHaveLength(1);
    expect(idx.forHook("posts", "after_create")).toEqual([]);
  });
});
