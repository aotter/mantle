import { defineAdmin } from "../../dist/admin-app/index.js";
import { useEntries, useView } from "../../dist/admin-app/hooks.js";
import "./brand.css";

/** The application's own Admin entry, as the browser test builds it: one `both` override and one page for an MCP App view. */
function Queue() {
  const { rows, status } = useView("queue", {});
  // browser-only hooks read `unavailable` in a host: the page still renders
  const { status: entries } = useEntries("requests");
  return <section className="bg-[#c0ffee]"><h2>queue-page</h2><p>entries:{entries}</p><ul>{rows.map(row => <li key={String(row["id"])}>page:{String(row["item"])}</li>)}</ul><p>view:{status}</p></section>;
}

export default defineAdmin({}, {
  components: {
    "cell:view:pending.item": ({ value, surface }) => <mark data-surface={surface} className="bg-[#fedcba]">{String(value)}</mark>,
  },
  pages: [{ path: "queue", title: "Queue", element: <Queue />, mcp: { renders: "queue" } }],
});
