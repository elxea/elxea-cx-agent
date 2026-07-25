// Render the 6-slot Option A (bigger-label) rich-menu PNG at 2500x1686.
// Reproducible source for assets/rich-menu/richmenu-optionA-6slot-bigger.png.
// Usage: node assets/rich-menu/render.mjs   (requires playwright)
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const FILE = join(DIR, "richmenu-optionA-6slot-bigger.html");
const OUT = join(DIR, "richmenu-optionA-6slot-bigger.png");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 2500, height: 1686 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
// hermetic: only allow local file/data URLs
await page.route("**/*", (r) => {
  const u = r.request().url();
  (u.startsWith("file://") || u.startsWith("data:") || u.startsWith("about:") || u.startsWith("blob:"))
    ? r.continue()
    : r.abort();
});
await page.goto("file://" + FILE, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(300);
await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 2500, height: 1686 } });
console.log("WROTE", OUT);
await browser.close();
