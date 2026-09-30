/**
 * `toCloudflareCron` (ADR-0032 decision 5 and amendment "the service preset"): a five-field POSIX cron (weekday 0 = Sunday) as
 * Cloudflare's cron triggers spell it (weekday 1 = Sunday through 7 = Saturday). Only explicit weekday numbers move. It lives in
 * spec, outside the barrel, so the CLI can write `wrangler.jsonc` with it; `@aotter/mantle/cloudflare` is its public home.
 */
const PART = /^(\*|\d+|[A-Za-z]{3})(?:-(\d+|[A-Za-z]{3}))?(?:\/(\d+))?$/;

export function toCloudflareCron(cron: string): string {
  const refuse = (why: string): never => {
    throw new Error(`Cannot map the cron '${cron}' to Cloudflare: ${why}`);
  };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) refuse("a cron has five fields (minute hour day-of-month month weekday)");
  const parts = fields.map((f) => f.split(",").map((p) => PART.exec(p) ?? refuse(`'${p}' is not a number, name, *, range or step`)));
  // POSIX runs on either day when both are restricted; Cloudflare does not document that rule, so only one may be
  if (fields[2] !== "*" && fields[4] !== "*") refuse("restrict the day of month or the weekday, not both");
  const day = (n: string | undefined) => {
    if (n === undefined || !/^\d+$/.test(n)) return n; // `*` and names mean the same day on both
    if (Number(n) > 6) refuse(`weekday ${n} is not POSIX (0-6, 0 = Sunday)`);
    return String(Number(n) + 1);
  };
  const weekday = parts[4]!.map(([, start, end, step]) => `${day(start)}${end ? `-${day(end)}` : ""}${step ? `/${step}` : ""}`).join(",");
  return [...fields.slice(0, 4), weekday].join(" ");
}
