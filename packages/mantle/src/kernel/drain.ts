/** Request-time only: no Worker startup path imports this. */

/** Read and discard what is left of a request body, at most 1 MiB and 1 s. A response sent over an unread POST body makes local
 *  `wrangler dev` break the connection, and the next request fails with "Network connection lost". */
async function drain(request: Request): Promise<void> {
  let reader: { read(): Promise<{ done: boolean; value: Uint8Array }>; cancel(): Promise<void> } | undefined;
  const timer = setTimeout(() => reader?.cancel().catch(() => {}), 1000);
  try {
    reader = request.body?.getReader(); // a body the app consumed is done; one it still holds is locked and throws
    for (let read = 0, chunk; reader && !(chunk = await reader.read()).done;) if ((read += chunk.value.byteLength) > 1024 * 1024) return await reader.cancel();
  } catch { /* the client went away */ } finally { clearTimeout(timer); }
}

/** A request handler that drains the body once it has answered or thrown. `undefined` and `null` mean the request is not this
 *  handler's, so the next handler can still read it. A handler that answers and reads the request later (in `waitUntil`) must
 *  read or lock the body before answering. */
export const draining = <A extends [Request, ...any[]], R>(handle: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
  let response: R;
  try { response = await handle(...args); } catch (error) { await drain(args[0]); throw error; }
  if (response != null) await drain(args[0]);
  return response;
};
