// Render the smaller-label 6-slot Option A candidates at 2500x1686. Read-only mockups.
import pkg from "/Users/setaka/github/elxea/products/elxea-dashboard/node_modules/playwright/index.js";
const { chromium } = pkg;
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const DIR = dirname(fileURLToPath(import.meta.url));
const TARGETS = ["richmenu-optionA-6slot-sm14", "richmenu-optionA-6slot-xs12"];
const browser = await chromium.launch();
for (const t of TARGETS) {
  const ctx = await browser.newContext({ viewport: { width: 2500, height: 1686 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.route("**/*", (r) => {
    const u = r.request().url();
    (u.startsWith("file://") || u.startsWith("data:") || u.startsWith("about:") || u.startsWith("blob:"))
      ? r.continue() : r.abort();
  });
  await page.goto("file://" + join(DIR, t + ".html"), { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(DIR, t + ".png"), clip: { x: 0, y: 0, width: 2500, height: 1686 } });
  await ctx.close();
  console.log("WROTE", t + ".png");
}
await browser.close();
