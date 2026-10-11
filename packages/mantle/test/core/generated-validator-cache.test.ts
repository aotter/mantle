import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RuntimePlan } from "../../src/spec/domain/index.js";
import { planValidators, type GeneratedValidators } from "../../src/core/runtime/validators.js";

const plan = (type: "string" | "number"): RuntimePlan => ({
  procedures: { p: { input: { type }, output: { type } } },
  views: { v: { input: { type } } },
}) as unknown as RuntimePlan;

describe("generated validator cache isolation", () => {
  it("keeps fallback schemas tied to each plan when two plans share a partial generated table", () => {
    const generated: GeneratedValidators = { procedure: { p: { input: () => z.boolean() } } };
    const a = plan("string"), b = plan("number");
    const first = planValidators(a, generated), second = planValidators(b, generated);
    expect(second).not.toBe(first);
    expect(planValidators(a, generated)).toBe(first);
    expect(planValidators(b, generated)).toBe(second);
    expect(first.procedure("p", "input").safeParse(true).success).toBe(true);
    expect(second.procedure("p", "input").safeParse(true).success).toBe(true);
    expect(first.procedure("p", "output").safeParse("value").success).toBe(true);
    expect(second.procedure("p", "output").safeParse("value").success).toBe(false);
    expect(second.procedure("p", "output").safeParse(7).success).toBe(true);
    expect(first.view("v")!.safeParse(7).success).toBe(false);
    expect(second.view("v")!.safeParse(7).success).toBe(true);
  });
  it("keeps generated table identities and ordinary fallback separate for one plan", () => {
    const p = plan("string");
    const a = { procedure: { p: { input: () => z.boolean() } } };
    const b = { procedure: { p: { input: () => z.number() } } };
    const ordinary = planValidators(p);
    const first = planValidators(p, a), second = planValidators(p, b);
    expect(first).not.toBe(second);
    expect(first).not.toBe(ordinary);
    expect(second.procedure("p", "input").safeParse(7).success).toBe(true);
    expect(first.procedure("p", "input").safeParse(7).success).toBe(false);
    expect(ordinary.procedure("p", "input").safeParse("value").success).toBe(true);
    expect(planValidators(p, a)).toBe(first);
    expect(planValidators(p)).toBe(ordinary);
  });
  it("ignores inherited input/output factories and constructs only own factories once", () => {
    const inherited = vi.fn(() => z.never());
    const own = vi.fn(() => z.boolean());
    const p = plan("string");
    const generated = { procedure: { p: Object.assign(Object.create({ output: inherited }), { input: own }) } };
    const validators = planValidators(p, generated);
    expect(validators.procedure("p", "output").safeParse("value").success).toBe(true);
    expect(validators.procedure("p", "input").safeParse(true).success).toBe(true);
    expect(validators.procedure("p", "input")).toBe(validators.procedure("p", "input"));
    expect(inherited).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledTimes(1);
  });
});
