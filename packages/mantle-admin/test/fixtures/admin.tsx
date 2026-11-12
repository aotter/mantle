import { useEffect, useState } from "react";
import { AdminLink, defineAdmin } from "../../dist/admin-app/index.js";
import { useEntries, useHost, useView } from "../../dist/admin-app/hooks.js";
import "./brand.css";

/** The application's own Admin entry, as the browser test builds it: one `both` override and one page for an MCP App view. */
function Queue() {
  const { rows, status, hasMore, loadMore } = useView("queue", {});
  // browser-only hooks read `unavailable` in a host: the page still renders
  const { status: entries } = useEntries("requests");
  // an app tool the model can call while the page is shown: it changes what the page shows, nothing on the server
  const host = useHost();
  const [only, setOnly] = useState<string | null>(null);
  useEffect(() => host?.registerTools([{
    name: "queue_only",
    title: "Show one item",
    description: "Shows only the queue item with this name on the open Queue page.",
    inputSchema: { type: "object", properties: { item: { type: "string", minLength: 1 } }, required: ["item"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: args => {
      if (typeof args["item"] !== "string" || !args["item"]) throw new Error("Name an item.");
      setOnly(args["item"]);
      return `Showing ${args["item"]}.`;
    },
  }]), [host]);
  const shown = rows.filter(row => !only || row["item"] === only);
  return <section className="bg-[#c0ffee]"><h2>queue-page</h2><p>entries:{entries}</p>{only ? <p>only:{only}</p> : null}<QueueCount count={shown.length} /><ul>{shown.map(row => <li key={String(row["id"])}>page:{String(row["item"])}</li>)}</ul><p>view:{status}</p>{hasMore ? <button onClick={() => { void loadMore(); }}>More queue</button> : null}</section>;
}

/** A component the page renders registers a tool of its own beside the page's: re-registered with the same definition as the count changes. */
function QueueCount({ count }: { count: number }) {
  const host = useHost();
  useEffect(() => host?.registerTools([{
    name: "queue_count",
    description: "How many queue items the open Queue page shows.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: () => `${count} shown.`,
  }]), [host, count]);
  return null;
}

function QueueHelp() {
  const host = useHost();
  return host && !host.capabilities.openLinks ? <span>Help unavailable</span> : <AdminLink href="https://example.test/help">Queue help</AdminLink>;
}

export default defineAdmin({}, {
  components: {
    "cell:view:pending.item": ({ value, surface }) => <mark data-surface={surface} className="bg-[#fedcba]">{String(value)}</mark>,
  },
  pages: [{ path: "queue", title: { en: "Queue", "zh-TW": "待辦" }, header: { description: { en: "Work queue", "zh-TW": "工作待辦" }, actions: <QueueHelp /> }, element: <Queue />, mcp: { renders: "queue" } }],
});
