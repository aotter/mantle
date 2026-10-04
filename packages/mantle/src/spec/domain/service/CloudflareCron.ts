/**
 * `toCloudflareCron` (ADR-0032 decision 5 and amendment "the service preset"): a five-field POSIX cron (weekday 0 = Sunday) as
 * Cloudflare's cron triggers spell it (weekday 1 = Sunday through 7 = Saturday). Only explicit weekday numbers move. It lives in
 * spec, outside the barrel, so the CLI can write `wrangler.jsonc` with it; `@aotter/mantle/cloudflare` is its public home.
 */
const PART = /^(\*|\d+|[A-Za-z]{3})(?:-(\d+|[A-Za-z]{3}))?(?:\/(\d+))?$/;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
/** label, lowest, highest, names (by value from `lowest`) */
const FIELDS: readonly (readonly [string, number, number, readonly string[] | null])[] = [["minute", 0, 59, null], ["hour", 0, 23, null], ["day of month", 1, 31, null], ["month", 1, 12, MONTHS], ["weekday", 0, 6, DAYS]];

export function toCloudflareCron(cron: string): string {
  const refuse = (why: string): never => {
    throw new Error(`Cannot map the cron '${cron}' to Cloudflare: ${why}`);
  };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) refuse("a cron has five fields (minute hour day-of-month month weekday)");
  const weekday: string[] = [];
  fields.forEach((field, i) => {
    const [label, min, max, names] = FIELDS[i]!;
    // a value as a number: a name counts as its number, and a number must be written plainly (`01` and `1` are one value)
    const value = (token: string): number => {
      if (/^\d+$/.test(token)) {
        if (token.length > 1 && token.startsWith("0")) refuse(`'${token}' has a leading zero`);
        if (i === 4 && Number(token) > 6) refuse(`weekday ${token} is not POSIX (0-6, 0 = Sunday)`);
        if (Number(token) < min || Number(token) > max) refuse(`${label} ${token} is outside ${min}-${max}`);
        return Number(token);
      }
      const at = names?.indexOf(token.toUpperCase()) ?? -1;
      if (at < 0) refuse(`'${token}' is not a valid ${label}`);
      return at + min;
    };
    const day = (token: string | undefined) => (i === 4 && token !== undefined && /^\d+$/.test(token) ? String(Number(token) + 1) : token);
    const out = field.split(",").map((p) => {
      const [, start, end, step] = PART.exec(p) ?? refuse(`'${p}' is not a number, name, *, range or step`);
      if (start === "*") {
        if (end) refuse(`'${p}' is not a range`);
      } else {
        const a = value(start!);
        if (end && value(end) < a) refuse(`'${p}' is a range that runs backwards`);
        if (step !== undefined && !end && !/^\d+$/.test(start!)) refuse(`'${p}' is a name with a step`);
      }
      if (step !== undefined && (/^0\d/.test(step) || Number(step) < 1)) refuse(`'${p}' has a step of '${step}'`);
      return `${day(start)}${end ? `-${day(end)}` : ""}${step ? `/${step}` : ""}`;
    });
    if (i === 4) weekday.push(...out);
  });
  // POSIX runs on either day when both are restricted; Cloudflare does not document that rule, so only one may be
  if (fields[2] !== "*" && fields[4] !== "*") refuse("restrict the day of month or the weekday, not both");
  return [...fields.slice(0, 4), weekday.join(",")].join(" ");
}
