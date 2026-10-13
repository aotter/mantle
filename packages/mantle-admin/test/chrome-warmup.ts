import { chromium } from "playwright";

/**
 * Starts Chrome once before any test file runs. A runner's first, cold launch (fonts, profile, disk cache) can take longer than the
 * 8 s launch budget the browser tests keep so that a missing Chrome fails fast; after one launch, later launches take a second or two.
 * A Chrome that cannot start is left for those tests to report.
 */
export default async function warmChrome(): Promise<void> {
  try {
    const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true, timeout: 60_000 });
    await browser.close();
  } catch {
    // the browser tests report a missing or broken Chrome themselves
  }
}
