/**
 * LINE のカードは `Image Main_LINE Card` だけを読む (設計 v2)。
 * (1) Shopify の列を変えても LINE のカードの写真は変わらない。
 * (2) 移す道具 (elxea-asset-hub scripts/backfill-line-card.ts) の **予行の出力そのもの** を読み、
 *     写したあとの bot の読み方を確かめる (検証 F6: 写す計算をテストの中で書き直さない)。
 *     - 写せた行: 新しい読み方 = 道具が書く写しの URL (elxea の R2)。いまの読み方 = 道具が中身を測った元の URL。
 *       中身 (sha256) が同じことは道具の --verify が両方の URL を取って確かめる (ここではキーと sha256 の整合だけ)。
 *     - 元の写真がもう無い行 (source_missing): いまも切れた写真を指している。写したあとは写真なし。
 * fixtures は 2026-10-01 の実物の写し (Operations Hub の単品 28 行) と、その予行の出力。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapProductImagePage, LINE_CARD_IMAGE_FIELD } from "../../src/lib/tea-menu";
import { preferDirectR2, hasRealPhoto } from "../../src/lib/flex-templates";

type Row = { sku: string; lineGiftMain: string | null; shopifyMain: string | null; lineCardMain: string | null };
const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/line-card");
const url = (u: string | null) => ({ type: "url", url: u });
const page = (r: Row) => ({
  id: `p-${r.sku}`,
  properties: {
    SKU: { type: "title", title: [{ plain_text: r.sku }] },
    Tags_Shopify: { type: "multi_select", multi_select: [{ name: "Single Pack" }] },
    "Image Main_LINE Gift": url(r.lineGiftMain),
    "Image Main_Shopify": url(r.shopifyMain),
    [LINE_CARD_IMAGE_FIELD]: url(r.lineCardMain),
  },
});
/** 切り替える前の bot の読み方 (c9deeb7 の mapProductImagePage と同じ式)。 */
const legacy = (r: Row) => preferDirectR2(r.lineGiftMain || r.shopifyMain);
const newRead = (r: Row) => mapProductImagePage(page(r) as never)?.imageUrl ?? null;

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok ${name}`); };

t("Shopify の列だけ変えても LINE のカードは変わらない", () => {
  const before: Row = { sku: "TEA-STMS-10101-FL-01", lineGiftMain: null, shopifyMain: "https://a.example/old.jpg", lineCardMain: "https://a.example/card.jpg" };
  assert.equal(newRead(before), "https://a.example/card.jpg");
  assert.equal(newRead({ ...before, shopifyMain: "https://a.example/NEW.jpg" }), "https://a.example/card.jpg");
});
t("LINE のカードの列が空なら写真なし (Shopify・LINE ギフトの列を予備に読まない)", () => {
  assert.equal(newRead({ sku: "TEA-STMS-10101-FL-01", lineGiftMain: "https://g/x.jpg", shopifyMain: "https://a.example/s.jpg", lineCardMain: null }), null);
});

type Plan = {
  mode: string;
  records: { pageId: string; sku: string; source: { url: string; sha256: string }; copy: { key: string; url: string } }[];
  failed: { pageId: string; sku: string; kind: string; sourceUrl: string }[];
  keep: { sku: string; reason: string }[];
};
const snap = JSON.parse(fs.readFileSync(path.join(FIX, "opshub-singlepack-20261001.json"), "utf8")) as { rows: Row[] };
const plan = JSON.parse(fs.readFileSync(path.join(FIX, "backfill-plan-20261001.json"), "utf8")) as Plan;
const bySku = new Map(snap.rows.map((r) => [r.sku, r]));

t("予行の出力は単品 28 行を全部扱う (写す・元が無い・触らない)", () => {
  assert.equal(snap.rows.length, 28);
  assert.equal(plan.records.length + plan.failed.length + plan.keep.length, 28);
  assert.equal(plan.mode, "dry-run");
});
t("写せる行: 新しい読み方は道具の写しの URL (R2・Shopify ではない)、いまの読み方は道具が測った元の URL", () => {
  assert.ok(plan.records.length > 0);
  for (const rec of plan.records) {
    const r = bySku.get(rec.sku)!;
    assert.equal(legacy(r), rec.source.url, rec.sku);
    const migrated = { ...r, lineCardMain: rec.copy.url };
    assert.equal(newRead(migrated), rec.copy.url, rec.sku);
    assert.ok(!rec.copy.url.includes("cdn.shopify.com"), rec.sku);
    assert.match(rec.copy.key, new RegExp(`main_linecard\\.v-${rec.source.sha256.slice(0, 12)}\\.(jpg|png)$`), rec.sku);
    assert.ok(hasRealPhoto(newRead(migrated)));
  }
});
t("元の写真がもう無い行 (source_missing): いまの bot は切れた URL を出している。写したあとは写真なし", () => {
  for (const f of plan.failed) {
    assert.equal(f.kind, "source_missing", f.sku);
    const r = bySku.get(f.sku)!;
    assert.equal(legacy(r), f.sourceUrl, f.sku);
    assert.equal(newRead(r), null, f.sku); // 新しい列は空のまま
  }
});
console.log(`line-card-image: ${n} passed`);
