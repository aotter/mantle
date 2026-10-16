import { type HomeProps, type SlotProps } from "@aotter/mantle-admin/app";
import { useView } from "@aotter/mantle-admin/hooks";

/**
 * Surface: browser (Admin's own page only; an MCP host never renders it).
 * Slots: Home
 * Rules: read data only through @aotter/mantle-admin/hooks and link with <AdminLink>. Pass the props you
 * received to `renderDefault`; spread them to change some.
 */

/** The built-in home page under a section listing the first rows of the admin View `pending-requests`. */
export function AdminHome(props: SlotProps<HomeProps>) {
  const queue = useView("pending-requests", {}, { limit: 5 });
  return (
    <>
      {queue.status === "ready" ? (
        <section className="mb-6 rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-semibold">Waiting for you ({queue.rows.length}{queue.hasMore ? "+" : ""})</h2>
          <ul className="space-y-1 text-sm">
            {queue.rows.map((row, index) => <li key={index} className="truncate">{String(Object.values(row)[0] ?? "")}</li>)}
          </ul>
        </section>
      ) : null}
      {props.renderDefault(props)}
    </>
  );
}
