import { csvCell } from "../csv.js";
/** Read the first page before answering; subsequent errors fail the stream. */
export async function csv(name: string, read: (cursor?: string) => Promise<{rows: readonly Record<string, unknown>[]; nextCursor?: string}>, declared?: readonly string[]): Promise<Response> {
  let page = await read();
  const columns = declared?.length ? declared : [...new Set(page.rows.flatMap(row => Object.keys(row)))];
  const line = (values: readonly unknown[]) => values.map(value => csvCell(value)).join(",") + "\r\n";
  async function* chunks() {
    yield "\uFEFF" + line(columns);
    for (;;) {
      yield page.rows.map(row => line(columns.map(column => row[column]))).join("");
      if (!page.nextCursor) return;
      const previous = page.nextCursor;
      page = await read(previous);
      if (page.nextCursor === previous) throw new Error("Export paging did not advance.");
    }
  }
  const iterator = chunks(), encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(undefined); },
  }), {headers: {"content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${encodeURIComponent(name)}.csv"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff"}});
}
