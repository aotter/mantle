export { dateFromFieldValue, formatMoneyMinor, formatTimestampMs, moneyMinorHint, timestampHint } from "@aotter/mantle-ui";

/** Keep the distinguishing suffix; callers expose the full id in `title`. */
export function idTail(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(-length);
}
