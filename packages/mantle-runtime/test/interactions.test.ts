import { readFileSync } from "node:fs";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { describe, expect, it, vi } from "vitest";
import { bindCapabilities, type CapabilityRuntime } from "../src/bindCapabilities.js";
import { compileRuntimePlan, type RuntimePlan } from "../src/domain/service/RuntimePlanCompiler.js";
import type { HandlerContext } from "../src/domain/model/HandlerContext.js";

/** ADR-0029 §7–9: interaction descriptors compiled into the sealed plan. */

function compile(text: string): RuntimePlan {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:interactions", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error("expected compiled plan");
  return compiled.value;
}

function procurement(): RuntimePlan {
  const doc = readFileSync(new URL("../../../docs/examples/builtin-procurement.md", import.meta.url), "utf8");
  const blocks = [...doc.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((match) => match[1]!);
  return compile(blocks.join("\n---\n"));
}

const custom = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: tickets }
spec:
  title: Tickets
  lifecycle: operational
  uniqueIndexes: [[ticketNumber]]
  schema:
    type: object
    properties:
      ticketNumber: { type: string }
      subject: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: open-tickets }
spec:
  surface: staff
  from: tickets
  fields: [id, version, ticketNumber, subject]
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: ticket-numbers }
spec:
  surface: staff
  from: tickets
  fields: [ticketNumber]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: close-ticket }
spec:
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  input:
    type: object
    required: [ticketId, expectedVersion]
    properties:
      ticketId: { type: string }
      expectedVersion: { type: integer }
  output: { type: object }
  handler: { kind: ref, ref: closeTicket }
  target: { schema: tickets, id: ticketId, version: expectedVersion }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: notify-requester }
spec:
  input:
    type: object
    properties:
      ticket: { type: string, x-mantle-ref: { schema: tickets, field: ticketNumber } }
  output: { type: object }
  handler: { kind: ref, ref: notify }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: undeclared }
spec:
  input: { type: object, properties: { ticketId: { type: string } } }
  output: { type: object }
  handler: { kind: ref, ref: undeclared }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: close-ticket-mcp }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: close-ticket }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: notify-requester-mcp }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: notify-requester }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: undeclared-mcp }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: undeclared }
`;

describe("interaction descriptors", () => {
  it("routes a pending-approvals row to review-requisition with id and version bound", () => {
    const plan = procurement();
    expect(plan.interactions).toContainEqual({
      procedure: "review-requisition",
      schema: "purchase-requisitions",
      bind: [{ input: "id", field: "id" }],
      version: "expectedVersion",
      mutates: true,
      views: ["pending-approvals"],
    });
    const catalog = bindCapabilities(runtime(plan), plan, { surface: "staff" }).catalog;
    const view = catalog.get("query_view_pending_approvals")!;
    expect(view.rowActions).toEqual([expect.objectContaining({
      capability: "review_requisition",
      bind: [{ input: "id", field: "id" }],
      version: "expectedVersion",
    })]);
    expect(view.description).toContain("Row actions: review_requisition (id = row.id, expectedVersion = row.version).");
  });

  it("compiles declared targets and references, and binds nothing for an undeclared ref handler", () => {
    const plan = compile(custom);
    expect(plan.interactions).toEqual([
      {
        procedure: "close-ticket",
        schema: "tickets",
        bind: [{ input: "ticketId", field: "id" }],
        version: "expectedVersion",
        mutates: true,
        views: ["open-tickets"],
      },
      {
        procedure: "notify-requester",
        schema: "tickets",
        bind: [{ input: "ticket", field: "ticketNumber" }],
        mutates: false,
        views: ["open-tickets", "ticket-numbers"],
      },
    ]);
  });

  it("offers a bounded staff read_entry for interaction targets only", async () => {
    const plan = compile(custom);
    const getEntry = vi.fn(async () => ({ id: "t1", collection: "tickets", version: 3, data: {} }));
    const staff = bindCapabilities({ ...runtime(plan), getEntry: { execute: getEntry } } as never, plan, { surface: "staff" });
    const read = staff.catalog.get("read_entry")!;
    expect(read).toMatchObject({ hints: { readOnly: true }, minimumRole: "contributor" });
    expect(read.inputSchema).toMatchObject({ properties: { collection: { enum: ["tickets"] } } });
    expect(await staff.execute({ name: "read_entry", args: { collection: "tickets", id: "t1" }, ctx: staffCtx() }))
      .toMatchObject({ ok: true, data: { version: 3 } });
    expect(await staff.execute({ name: "read_entry", args: { collection: "posts", id: "p1" }, ctx: staffCtx() }))
      .toMatchObject({ ok: false, diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
    const member = { ...staffCtx(), staff: null };
    expect(await staff.execute({ name: "read_entry", args: { collection: "tickets", id: "t1" }, ctx: member }))
      .toMatchObject({ ok: false });
    expect(getEntry).toHaveBeenCalledTimes(1);
    expect(bindCapabilities(runtime(plan), plan, { surface: "public" }).catalog.get("read_entry")).toBeUndefined();
    const plain = compile(custom.split("---").slice(0, 3).join("---"));
    expect(bindCapabilities(runtime(plain), plain, { surface: "staff" }).catalog.get("read_entry")).toBeUndefined();
  });
});

function runtime(plan: RuntimePlan): CapabilityRuntime {
  const unused = { execute: vi.fn() };
  return {
    schemas: new Map(Object.values(plan.schemas).map(({ manifest }) => [manifest.metadata.name, manifest])),
    getEntry: unused,
    createDraft: unused,
    updateDraft: unused,
    requestPublish: unused,
    unpublish: unused,
    archive: unused,
    deleteEntry: unused,
    executeView: vi.fn(),
    invokeTrigger: vi.fn(),
    media: null,
  } as unknown as CapabilityRuntime;
}

function staffCtx(): HandlerContext {
  return { user: { id: "s1" }, staff: { id: "s1", role: "editor" }, env: {} };
}
