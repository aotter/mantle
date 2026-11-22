import { AdminLink, defineAdmin } from "@aotter/mantle-admin/app";
import { Button, Card } from "@aotter/mantle-ui/kit";
import { admin, useView } from "../generated/admin-client.js";

/** A custom reading surface; the built-in record page still owns review and decisions. */
function ApprovalDesk() {
  const queue = useView("pending-requests", {});
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">
        Open a request to review its latest details and approve or reject it. Approval spends the department budget;
        rejection requires a reason and spends nothing. The server checks the balance and version when you decide.
      </p>
      <AdminLink className="underline" href="/admin/c/budgets">
        Review department budgets
      </AdminLink>
      {queue.status === "loading" ? <p role="status">Loading requests…</p> : null}
      {queue.status === "unavailable" ? <p role="status">The approval queue is unavailable.</p> : null}
      {queue.status === "error" ? (
        <p role="alert">Could not load all requests. Reload this page or retry loading more.</p>
      ) : null}
      {queue.status === "ready" && queue.rows.length === 0 ? <p>No requests are waiting for approval.</p> : null}
      <ul className="grid gap-4 lg:grid-cols-2">
        {queue.rows.map(row => (
          <li key={row.id} className="min-w-0">
            <Card className="h-full space-y-3 p-5">
              <h2 className="break-words text-lg font-semibold">{row.title}</h2>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted-foreground">Department</dt>
                <dd className="break-words">{row.department}</dd>
                <dt className="text-muted-foreground">Amount</dt>
                <dd>{row.amount}</dd>
              </dl>
              <Button asChild variant="secondary">
                <AdminLink aria-label={`Review ${row.title}`} href={`/admin/c/requests/${encodeURIComponent(row.id)}`}>
                  Review request
                </AdminLink>
              </Button>
            </Card>
          </li>
        ))}
      </ul>
      {queue.hasMore ? (
        <Button disabled={queue.loadingMore} onClick={queue.loadMore}>
          {queue.loadingMore ? "Loading…" : "Load more requests"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The Admin entry, built by `mantle bundle`. The approver's daily work gets its own sidebar group above Admin's
 * built-in ones (content 10, operations 20, reports 30; More stays last); manifests place `pending-requests` and
 * `requests` in it with `uiSchema.nav`. `tsc` refuses a manifest group left undeclared here.
 * AGENT: add groups for how the staff work; titles take one string or a { locale: text } map.
 */
export default defineAdmin(admin, {
  nav: { groups: { approvals: { title: { en: "Approvals", "zh-TW": "簽核" }, order: 5 } } },
  pages: [{ path: "guide", title: "Approval desk", element: <ApprovalDesk />, nav: { group: "approvals", order: 0 } }],
});
