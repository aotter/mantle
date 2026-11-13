/**
 * The upload card's `forward` arguments: they come from the rendering call's tool input, which a host delivers only
 * after the App connects and does not promise. Calls wait for it at most `timeoutMs` after connecting (`false`: until it
 * arrives), then go without it; an input that arrives after that is used from then on, and `late` runs so the card can
 * repeat what it read without it.
 */
export function forwardedInput(forward: readonly string[], timeoutMs: number | false, late: () => void) {
  const bound: Record<string, unknown> = {};
  let arrive = () => {},
    arrived = !forward.length,
    timedOut = false;
  const waiting = arrived
    ? Promise.resolve()
    : new Promise<void>(resolve => {
        arrive = resolve;
      });
  return {
    /** `args` with the forwarded arguments, once the input arrived or the wait ended. */
    async args(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      await waiting;
      return { ...args, ...bound };
    },
    /** The host connected: the wait starts. */
    connected(): void {
      if (!arrived && timeoutMs !== false)
        setTimeout(() => {
          if (arrived) return;
          timedOut = true;
          arrive();
        }, timeoutMs);
    },
    /** The host's tool input. */
    input(args: Readonly<Record<string, unknown>>): void {
      for (const name of forward) if (args[name] !== undefined) bound[name] = args[name];
      const first = !arrived;
      arrived = true;
      arrive();
      if (first && timedOut) late();
    },
  };
}
