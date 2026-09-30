import { expect, it } from "vitest";
import { toCloudflareCron } from "../../src/cloudflare/index.js";

it.each([
  ["0 2 * * *", "0 2 * * *"],
  ["0 0 * * 0", "0 0 * * 1"], // Sunday
  ["0 0 * * 6", "0 0 * * 7"], // Saturday
  ["0 0 * * 1-5", "0 0 * * 2-6"],
  ["0 0 * * 0,6", "0 0 * * 1,7"],
  ["0 0 * * 0-6", "0 0 * * 1-7"],
  ["0 0 * * 1-5/2", "0 0 * * 2-6/2"], // Mon, Wed, Fri on both
  ["0 0 * * */2", "0 0 * * */2"], // Sun, Tue, Thu, Sat on both
  ["0 0 * * 1/2", "0 0 * * 2/2"],
  ["0 0 * * SUN,3", "0 0 * * SUN,4"],
  ["*/15 9-17 * * MON-FRI", "*/15 9-17 * * MON-FRI"],
  ["0 0 * * MON-5", "0 0 * * MON-6"],
  ["5 4 1,15 JAN-JUN *", "5 4 1,15 JAN-JUN *"],
  ["0 0 */2 * *", "0 0 */2 * *"],
  ["  0  0 * * 0 ", "0 0 * * 1"],
])("%s is %s on Cloudflare", (posix, cloudflare) => {
  expect(toCloudflareCron(posix)).toBe(cloudflare);
});

it.each([
  ["0 0 * *", "five fields"],
  ["@daily", "five fields"],
  ["0 0 ? * 1", "'?' is not"],
  ["0 0 L * *", "'L' is not"],
  ["0 0 * * 5L", "'5L' is not"],
  ["0 0 * * 1#2", "'1#2' is not"],
  ["0 0 15W * *", "'15W' is not"],
  ["0 0 * * 7", "weekday 7 is not POSIX"],
  ["0 0 * * 5-7", "weekday 7 is not POSIX"],
  ["0 0 1 * 1", "not both"],
  ["0 0 */2 * MON", "not both"],
])("refuses %s", (cron, why) => {
  expect(() => toCloudflareCron(cron)).toThrow(`Cannot map the cron '${cron}' to Cloudflare:`);
  expect(() => toCloudflareCron(cron)).toThrow(why);
});
