/** Best-effort metadata callbacks: delivery belongs to the host, never to the business response. */
export function observe<T>(listener: ((event: T) => void | Promise<void>) | undefined, event: T): void {
  if (!listener) return;
  try { void Promise.resolve(listener(event)).catch(() => {}); } catch { /* The adopter owns delivery failure reporting. */ }
}
