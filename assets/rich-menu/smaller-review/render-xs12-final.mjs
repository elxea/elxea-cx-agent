// Render the FINAL owner-approved rich menu (Option A xs12 label 77px/12dp + KEPT 80px icon-label gap)
// at 2500x1686. Output goes to ../richmenu-optionA-6slot-xs12-final.png (repo-persisted).
import pkg from "/Users/setaka/github/elxea/products/elxea-dashboard/node_modules/playwright/index.js";
const { chromium } = pkg;
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(DIR, "richmenu-optionA-6slot-xs12-final.html");
const OUT = join(DIR, "..", "richmenu-optionA-6slot-xs12-final.png");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 2500, height: 1686 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.route("**/*", (r) => {
  const u = r.request().url();
  (u.startsWith("file://") || u.startsWith("data:") || u.startsWith("about:") || u.startsWith("blob:"))
    ? r.continue() : r.abort();
});
await page.goto("file://" + SRC, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(300);
await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 2500, height: 1686 } });
await ctx.close();
await browser.close();
console.log("WROTE", OUT);
