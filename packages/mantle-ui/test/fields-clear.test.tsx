import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldSlot, SchemaFieldsProps } from "../src/react/fields.js";

// Server rendering fires no events: the kit's controls are stood in for by ones that keep their props, so a test
// calls the handler a person's clear would.
const seen = vi.hoisted(() => [] as Record<string, any>[]);
const keep = (kind: string) => (props: Record<string, any>) => { seen.push({ kind, ...props }); return null; };
vi.mock("../src/kit/components/ui/input.js", () => ({ Input: keep("input") }));
vi.mock("../src/kit/components/ui/textarea.js", () => ({ Textarea: keep("textarea") }));
vi.mock("../src/kit/components/ui/button.js", () => ({ Button: keep("button") }));
vi.mock("../src/kit/components/ui/select.js", () => ({
  Select: (props: Record<string, any>) => { seen.push({ kind: "select", ...props }); return props["children"]; },
  SelectTrigger: (props: Record<string, any>) => { seen.push({ kind: "select-trigger", ...props }); return null; },
  SelectContent: ({ children }: { children: unknown }) => children,
  SelectItem: (props: Record<string, any>) => { seen.push({ kind: "select-item", ...props }); return null; },
  SelectValue: () => null,
}));
const { SchemaFields } = await import("../src/react/fields.js");

const schema = {
  type: "object",
  required: ["title", "status", "size", "starts", "owner"],
  properties: {
    title: { type: "string" },
    note: { type: "string" },
    summary: { type: "string" },
    body: { type: "string", "x-mcp-hint": "markdown" },
    status: { type: "string", enum: ["open", "closed"] },
    tier: { type: "string", enum: ["gold", "silver"] },
    size: { type: "integer" },
    count: { type: "integer" },
    due: { type: "string", format: "date-time" },
    starts: { type: "string", format: "date-time" },
    remindAt: { type: "integer", "x-mcp-hint": "timestamp-ms" },
    day: { type: "string", format: "date" },
    meta: { type: "object" },
    owner: { type: "string" },
    address: { type: "object", properties: { city: { type: "string" } } },
  },
} as const;
const value = { title: "t", note: "n", summary: "s", body: "b", status: "open", tier: "gold", size: 1, count: 2, due: "2026-10-25T08:00:00.000Z", starts: "2026-10-25T08:00:00.000Z", remindAt: 1792915200000, day: "2026-10-25", meta: { a: 1 }, owner: "o", address: { city: "Taipei" } };

/** Renders the form and returns the value the last change handed back. */
function form(props: Partial<SchemaFieldsProps> = {}) {
  seen.length = 0;
  let changed: Record<string, unknown> | undefined;
  renderToStaticMarkup(<SchemaFields schema={schema} uiSchema={{ fields: { summary: { widget: "textarea" } } }} value={value} onChange={(next) => { changed = next; }} language="en" {...props} />);
  const by = (kind: string, label: string) => seen.find((p) => p.kind === kind && p["aria-label"] === label);
  return {
    by,
    /** Empties a text, number or JSON box. */
    empty(kind: "input" | "textarea", label: string) { by(kind, label)!["onChange"]({ target: { value: "" } }); return changed!; },
    /** Picks an enum's empty choice. */
    notSet(label: string) { seen.filter((p) => p.kind === "select")[["Status", "Tier"].indexOf(label)]!["onValueChange"]("__empty__"); return changed!; },
    clearButton: (label: string) => by("button", `Clear: ${label}`),
    clear(label: string) { by("button", `Clear: ${label}`)!["onClick"](); return changed!; },
  };
}

beforeEach(() => { seen.length = 0; });

describe("a record form (clearToNull) clears an optional field to null", () => {
  it("text, textarea, markdown fallback and date inputs", () => {
    const f = form({ clearToNull: true });
    expect(f.empty("input", "Note")).toMatchObject({ note: null });
    expect(f.empty("textarea", "Summary")).toMatchObject({ summary: null });
    expect(f.empty("textarea", "Body")).toMatchObject({ body: null });
    expect(f.empty("input", "Day")).toMatchObject({ day: null });
  });

  it("an enum's Not set and an emptied number, which JSON would otherwise drop", () => {
    const f = form({ clearToNull: true });
    const cleared = f.notSet("Tier");
    expect(cleared).toHaveProperty("tier", null);
    expect(JSON.parse(JSON.stringify(cleared))).toHaveProperty("tier", null);
    expect(f.empty("input", "Count")).toHaveProperty("count", null);
  });

  it("date-time and timestamp pickers have a clear button", () => {
    const f = form({ clearToNull: true });
    expect(f.clear("Due")).toHaveProperty("due", null);
    expect(f.clear("Remind At")).toHaveProperty("remindAt", null);
  });

  it("a JSON value's emptied box", () => {
    form({ clearToNull: true });
    // the JSON box is the textarea without a label of its own
    const box = seen.find((p) => p.kind === "textarea" && p["aria-label"] === undefined)!;
    expect(box["value"]).toBe('{\n  "a": 1\n}');
    let changed: Record<string, unknown> | undefined;
    seen.length = 0;
    renderToStaticMarkup(<SchemaFields schema={{ type: "object", properties: { meta: { type: "object" } } }} value={{ meta: { a: 1 } }} onChange={(next) => { changed = next; }} language="en" clearToNull />);
    seen.find((p) => p.kind === "textarea")!["onChange"]({ target: { value: " " } });
    expect(changed).toEqual({ meta: null });
  });

  it("tells a host's control the field's cleared value and whether it is required", () => {
    const slots: FieldSlot[] = [];
    renderToStaticMarkup(<SchemaFields schema={schema} value={value} onChange={() => {}} language="en" clearToNull renderField={(field) => { slots.push(field); return null; }} />);
    const slot = (name: string) => slots.find((s) => s.name === name)!;
    expect([slot("note").cleared, slot("note").required]).toEqual([null, false]);
    expect([slot("owner").cleared, slot("owner").required]).toEqual([undefined, true]);
  });
});

describe("required fields stay unclearable", () => {
  it("no Not set, no clear button; emptied text stays the empty string as before", () => {
    const f = form({ clearToNull: true });
    expect(seen.filter((p) => p.kind === "select-item" && p["value"] === "__empty__")).toHaveLength(1);
    expect(f.clearButton("Starts")).toBeUndefined();
    expect(f.empty("input", "Title")).toHaveProperty("title", "");
    expect(f.empty("input", "Size")).toHaveProperty("size", undefined);
  });

  it("a nested property of a JSON value is not a column: it keeps the empty string", () => {
    const f = form({ clearToNull: true });
    expect(f.empty("input", "City")).toMatchObject({ address: { city: "" } });
  });
});

describe("outside a record form (an operation's input)", () => {
  it("a cleared field is left out, and text is the empty string, unless null is one of its values", () => {
    const f = form();
    expect(f.empty("input", "Note")).toHaveProperty("note", "");
    expect(f.notSet("Tier")).toHaveProperty("tier", undefined);
    expect(f.empty("input", "Count")).toHaveProperty("count", undefined);
    expect(f.clear("Due")).toHaveProperty("due", undefined);
    seen.length = 0;
    let changed: Record<string, unknown> | undefined;
    renderToStaticMarkup(<SchemaFields schema={{ type: "object", properties: { note: { type: ["string", "null"] } } }} value={{ note: "x" }} onChange={(next) => { changed = next; }} language="en" />);
    seen.find((p) => p.kind === "input")!["onChange"]({ target: { value: "" } });
    expect(changed).toEqual({ note: null });
  });

  it("shows no clear button without a value", () => {
    seen.length = 0;
    renderToStaticMarkup(<SchemaFields schema={{ type: "object", properties: { due: { type: "string", format: "date-time" } } }} value={{}} onChange={() => {}} language="en" clearToNull />);
    expect(seen.find((p) => p.kind === "button" && p["aria-label"] === "Clear: Due")).toBeUndefined();
  });
});
