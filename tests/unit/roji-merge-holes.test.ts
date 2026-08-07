/**
 * Unit Tests — 合流の穴（穴1・穴2・穴3）の封鎖
 *
 * 一次入力（仕様の正本）:
 *   roji同じ人だと分かる仕組み  https://www.notion.so/3b570c9d064c81d68610f9360f50c965
 *     第3章「いまの実装に実在する穴（4件）」/ 第5章「合流の衝突をどう解くか」
 *   rojiカルテの項目 — 最終形の定義  https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
 *
 * 何を守るテストか（ロードベアリング＝直したものを戻すと必ず赤くなる）:
 *   穴1  持ち越しが persona / tasteProfile の 2 つに固定されていた。
 *        → 規則の表に基づき、**未連携カルテに実在する全キー**が持ち越される。
 *        → 表に無い未知の項目も既定で持ち越される（＝項目を足しても落ちない）。
 *   穴2  好みが空だと早期 return して「合流済みの印」すら書かれなかった（純粋層の担保をここで、
 *        書き込みの担保はハーメティック flow9 で）。
 *   共通 いかなる規則でも**既存の値を消さない**（追加と、衝突時の足あと記録のみ）。
 *
 * 依存: karte-merge-rules.ts は型以外を import しない純粋モジュール（Workers API 非依存）。
 * 使用: npx tsx tests/unit/roji-merge-holes.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KARTE_MERGE_RULES,
  DEFAULT_RULE,
  computeKarteCarryover,
  isEmptyValue,
  ruleFor,
  type SpecialFolders,
} from "../../src/lib/karte-merge-rules";
import type { CustomerProfile, LineUserProfile } from "../../src/lib/firestore";

let total = 0;
let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failures.push({ name, error: e instanceof Error ? e.message : String(e) });
    console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assertTrue(v: boolean, label: string) {
  if (!v) throw new Error(label);
}
function assertEq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

/**
 * persona / taste の畳み込みはここでは検証範囲外（flow9 が本番ロジックで担保）。
 * 「規則の表が persona/taste をどの戦略に割り当てているか」だけを見たいので、識別可能な
 * ダミーを返す folder を注入する。
 */
const FOLDERS: SpecialFolders = {
  foldPersona: (line) =>
    line ? { primary: "sensory", scores: { serenity: 1, explorer: 0, sensory: 1 }, lastUpdated: "T" } : undefined,
  foldTaste: (line) =>
    line ? { preferredCategories: ["folded"], flavorPreferences: [], scenePref: null } : undefined,
};

const CTX = {
  lineUserId: "Utest0000000000000000000000000000",
  shopifyCustomerId: "900800400901",
  now: "2026-08-08T12:00:00.000Z",
};

function carry(line: LineUserProfile, customer: CustomerProfile | null) {
  return computeKarteCarryover(line, customer, CTX, FOLDERS);
}

console.log("\n=== 穴1: 入口の答え（onboarding）が合流で落ちない ===");

it("穴1-A: 入口の答えだけを持つカルテ → onboarding が本カルテへ持ち越される", () => {
  // ★ ロードベアリング。改修前の実装は persona/tasteProfile しか見ていないため、
  //   この 1 行が「合流の瞬間にアンケート/入口の答えが消える」を検知する。
  const { updates, record } = carry(
    { lineUserId: CTX.lineUserId, onboarding: { completedAt: null, initialAction: null, source: "marche" } },
    null,
  );
  assertEq((updates.onboarding as { source?: string })?.source, "marche", "source が持ち越される");
  assertTrue(record.carried.includes("onboarding"), "合流の記録に onboarding が載る");
});

it("穴1-B: 本カルテに onboarding が在っても source が空なら、サブキー単位で持ち越される", () => {
  // updateMask はトップレベルのキー単位なので、丸ごと上書きすると completedAt を消す。
  // サブキー単位のマージであることをここで固定する。
  const { updates } = carry(
    { onboarding: { completedAt: null, initialAction: null, source: "online" } },
    { onboarding: { completedAt: "2026-07-01T00:00:00Z", initialAction: "about" } },
  );
  const ob = updates.onboarding as Record<string, unknown>;
  assertEq(ob.source, "online", "未連携側の source が入る");
  assertEq(ob.completedAt, "2026-07-01T00:00:00Z", "本カルテの completedAt を消さない");
  assertEq(ob.initialAction, "about", "本カルテの initialAction を消さない");
});

console.log("\n=== 穴1: タスク07 の カルテ 7 項目（6 / 12 / 13 / 14 / 18 / 19 / 20）が全部載る ===");

/** 定義文書の項目番号 → 実装のフィールド名。 */
const KARTE_7 = {
  6: "safety",
  12: "windowAffinity",
  13: "teaRequests",
  14: "eventInterest",
  18: "quoteConsent",
  19: "estimateLine",
  20: "estimateCorrection",
} as const;

it("7 項目すべてが規則の表に明示エントリを持つ（既定に落ちていない）", () => {
  for (const [no, field] of Object.entries(KARTE_7)) {
    assertTrue(
      field in KARTE_MERGE_RULES,
      `項目${no}（${field}）が KARTE_MERGE_RULES に無い＝規則を決め忘れている`,
    );
  }
});

it("7 項目すべてが実際に持ち越される（空の本カルテへ）", () => {
  const line: LineUserProfile = {
    safety: { tags: ["allergy"], updatedAt: "2026-08-01T00:00:00Z" },
    windowAffinity: { tea: 3, literature: 1 },
    teaRequests: { moreOf: ["00123"], noneOf: ["00999"] },
    eventInterest: "onsite",
    quoteConsent: true,
    estimateLine: "静かな時間を好む",
    estimateCorrection: { choice: "explore", correctedAt: "2026-08-02T00:00:00Z" },
  };
  const { updates, record } = carry(line, null);
  for (const [no, field] of Object.entries(KARTE_7)) {
    assertTrue(
      record.carried.includes(field),
      `項目${no}（${field}）が持ち越されていない`,
    );
    assertTrue(
      (updates as Record<string, unknown>)[field] !== undefined,
      `項目${no}（${field}）が本カルテ差分に無い`,
    );
  }
});

console.log("\n=== 穴1: 未知の項目は既定で持ち越す（項目を足しても落ちない）===");

it("★ 表に無い新項目でも持ち越される（＝規則の追記を忘れてもデータは落ちない）", () => {
  // これが本タスクの核心。「項目を足すたびに合流処理の修正を忘れる」失敗様式を殺す。
  const line = {
    surveyAnswers: { q1: "a", q2: "c" },
    brandNewFieldNobodyDeclaredYet: "value",
  } as unknown as LineUserProfile;

  const { updates, record } = carry(line, null);
  assertEq(
    (updates as Record<string, unknown>).surveyAnswers,
    { q1: "a", q2: "c" },
    "未知の複合項目が持ち越される",
  );
  assertEq(
    (updates as Record<string, unknown>).brandNewFieldNobodyDeclaredYet,
    "value",
    "未知のスカラー項目が持ち越される",
  );
  assertEq(
    record.carriedByDefaultRule,
    ["brandNewFieldNobodyDeclaredYet", "surveyAnswers"],
    "既定規則で持ち越したことが記録に残る（表の追記漏れの可視化）",
  );
});

it("既定は carry-if-empty（表に無いキーの規則）", () => {
  assertEq(ruleFor("totallyUnknownField"), DEFAULT_RULE, "既定規則が引ける");
  assertEq(ruleFor("safety").strategy, "safety-union", "表のキーは表の規則が引ける");
});

console.log("\n=== 第5章: 種類別の衝突ルール ===");

it("数えるものは足す（項目12 窓への傾き）", () => {
  const { updates } = carry(
    { windowAffinity: { tea: 3, music: 2 } },
    { windowAffinity: { tea: 5, farm: 1 } },
  );
  const w = updates.windowAffinity as Record<string, number>;
  assertEq(w.tea, 8, "同じ窓は足す（上書きしない）");
  assertEq(w.music, 2, "未連携側だけの窓が入る");
  assertEq(w.farm, 1, "本カルテだけの窓が消えない");
});

it("好みは両方入れる・重複は1つに（項目13）", () => {
  const { updates } = carry(
    { teaRequests: { moreOf: ["00123", "00456"], noneOf: [] } },
    { teaRequests: { moreOf: ["00123"], noneOf: ["00999"] } },
  );
  const t = updates.teaRequests as Record<string, string[]>;
  assertEq(t.moreOf, ["00123", "00456"], "union・重複排除");
  assertEq(t.noneOf, ["00999"], "本カルテ側のリストが消えない");
});

it("★ 安全に関する申告は消す方向に統合しない（項目6）", () => {
  // 消す方向の統合を絶対にしない = ロードベアリング。
  const { updates } = carry(
    { safety: { tags: ["caffeine_sensitive"] } },
    { safety: { tags: ["allergy"] } },
  );
  const s = updates.safety as { tags: string[] };
  assertTrue(s.tags.includes("allergy"), "本カルテの申告が残る");
  assertTrue(s.tags.includes("caffeine_sensitive"), "未連携側の申告も残る");
});

it("安全: 「特にない」は実申告があれば落とす（厳しい側に倒す）が、落とした事実は記録に残る", () => {
  const { updates, record } = carry(
    { safety: { tags: ["allergy"] } },
    { safety: { tags: ["none"] } },
  );
  const s = updates.safety as { tags: string[] };
  assertEq(s.tags, ["allergy"], "none は実申告と併存させない");
  assertEq(
    (record.superseded.safety as Record<string, unknown>)?.droppedNoneTag,
    true,
    "落とした事実が足あとに残る",
  );
});

it("本人の設定は制限の強い方（項目18 引用の許可・既定は引用しない）", () => {
  assertEq(
    carry({ quoteConsent: false }, { quoteConsent: true }).updates.quoteConsent,
    false,
    "片方が false なら false（勝手に再開させない）",
  );
  assertEq(
    carry({ quoteConsent: true }, { quoteConsent: false }).updates.quoteConsent,
    undefined,
    "本カルテが false なら false のまま（書き換えない）",
  );
  assertEq(
    carry({ quoteConsent: true }, {}).updates.quoteConsent,
    true,
    "本カルテが未設定なら本人の同意を採る（未設定は拒否ではない）",
  );
});

it("本人の最新の意思が勝つ（項目20 1行の推定への訂正）", () => {
  const older = { choice: "old", correctedAt: "2026-07-01T00:00:00Z" };
  const newer = { choice: "new", correctedAt: "2026-08-01T00:00:00Z" };
  assertEq(
    (carry({ estimateCorrection: newer }, { estimateCorrection: older }).updates
      .estimateCorrection as { choice: string })?.choice,
    "new",
    "新しい方を採る",
  );
  const keepCustomer = carry({ estimateCorrection: older }, { estimateCorrection: newer });
  assertEq(keepCustomer.updates.estimateCorrection, undefined, "古い方は採らない");
  assertEq(
    (keepCustomer.record.superseded.estimateCorrection as { choice: string })?.choice,
    "old",
    "採らなかった値は足あとに残る（捨てない）",
  );
});

it("1つしか持てない属性は本カルテ優先・未連携側は足あとへ（項目14 イベントへの関心）", () => {
  const r = carry({ eventInterest: "online" }, { eventInterest: "onsite" });
  assertEq(r.updates.eventInterest, undefined, "本カルテの値を残す");
  assertEq(r.record.superseded.eventInterest, "online", "未連携側の値は捨てず足あとへ");

  const fill = carry({ eventInterest: "online" }, {});
  assertEq(fill.updates.eventInterest, "online", "本カルテが空なら未連携側から埋める");
});

console.log("\n=== 不変条件: 何ひとつ消さない ===");

it("★ どの規則を通っても、本カルテの既存キーが消える差分を出さない", () => {
  const customer: CustomerProfile = {
    membershipTier: "standard",
    email: "kept@example.test",
    onboarding: { completedAt: "2026-07-01T00:00:00Z", initialAction: "about" },
    safety: { tags: ["allergy"] },
    windowAffinity: { tea: 5 },
    teaRequests: { moreOf: ["00111"], noneOf: [] },
    eventInterest: "onsite",
    quoteConsent: false,
    estimateLine: "既存の1行",
  };
  const line: LineUserProfile = {
    lineUserId: CTX.lineUserId,
    onboarding: { completedAt: null, initialAction: null, source: "marche" },
    safety: { tags: ["caffeine_sensitive"] },
    windowAffinity: { tea: 2, music: 1 },
    teaRequests: { moreOf: ["00222"], noneOf: ["00999"] },
    eventInterest: "online",
    quoteConsent: true,
    estimateLine: "未連携側の1行",
  };
  const { updates } = carry(line, customer);
  const after = { ...customer, ...(updates as Record<string, unknown>) } as Record<string, unknown>;

  for (const key of Object.keys(customer)) {
    assertTrue(after[key] !== undefined, `合流後に ${key} が消えている`);
  }
  assertEq(after.email, "kept@example.test", "無関係なフィールドを触らない");
  assertEq(after.membershipTier, "standard", "会員種別を触らない");
  assertEq(after.estimateLine, "既存の1行", "本カルテの1行を上書きしない");
  assertEq((after.safety as { tags: string[] }).tags.length, 2, "安全の申告は足し算");
});

it("識別子・制御フラグは持ち越さない（項目2・3 は正本が別名表）", () => {
  const { updates } = carry(
    {
      lineUserId: CTX.lineUserId,
      mergedToShopify: false,
      createdAt: "2026-01-01T00:00:00Z",
      lastActiveAt: "2026-01-01T00:00:00Z",
      onboarding: { completedAt: null, initialAction: null, source: "marche" },
    },
    null,
  );
  const u = updates as Record<string, unknown>;
  assertTrue(!("lineUserId" in u), "LINE 側の識別子を本カルテへ写さない");
  assertTrue(!("mergedToShopify" in u), "制御フラグを本カルテへ写さない");
  assertTrue(!("createdAt" in u), "未連携カルテの作成時刻で本カルテを上書きしない");
});

it("合流の記録（項目33）に「いつ / どちらから / 何を」が揃う", () => {
  const { record } = carry({ onboarding: { completedAt: null, initialAction: null, source: "marche" } }, null);
  assertEq(record.mergedAt, CTX.now, "いつ");
  assertEq(record.fromLineUserId, CTX.lineUserId, "どちらの記録から");
  assertEq(record.toShopifyCustomerId, CTX.shopifyCustomerId, "どこへ");
  assertTrue(record.carried.length > 0, "何を持ち越したか");
});

console.log("\n=== 穴2（純粋層）: 好みが空でも合流の中身が成立する ===");

it("好みが空でも carryover は例外にならず記録を返す（印を書く経路へ進める）", () => {
  const { updates, record } = carry({ lineUserId: CTX.lineUserId }, null);
  assertEq(Object.keys(updates).length, 0, "持ち越すものは無い");
  assertEq(record.carried, [], "持ち越し 0 件でも記録は作る");
  assertEq(record.mergedAt, CTX.now, "合流時刻は入る");
});

console.log("\n=== 空判定 ===");

it("false と 0 を空扱いしない（本人が明示した設定・点数を空と誤判定しない）", () => {
  assertEq(isEmptyValue(false), false, "false は空ではない");
  assertEq(isEmptyValue(0), false, "0 は空ではない");
  assertEq(isEmptyValue(""), true, "空文字は空");
  assertEq(isEmptyValue([]), true, "空配列は空");
  assertEq(isEmptyValue({ a: undefined }), true, "全キーが空のオブジェクトは空");
});

console.log("\n=== 第2段: flow_events を web にも広げる（migration 035）===");

const SQL_035 = readFileSync(
  join("src/db/migrations", "035_flow_events_web_channel.sql"),
  "utf8",
);

it("035 は channel の CHECK を line+web に広げる", () => {
  assertTrue(
    /CHECK\s*\(channel\s+IN\s*\(\s*'line'\s*,\s*'web'\s*\)\)/.test(SQL_035),
    "広げた CHECK が入っている",
  );
});

it("035 は破壊的操作を含まない（追加のみ）", () => {
  const body = SQL_035.split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "ALTER COLUMN"]) {
    assertTrue(
      !new RegExp(forbidden, "i").test(body),
      `${forbidden} を含んではいけない（既存データを消さない）`,
    );
  }
});

it("021 の user_ref は LINE 固有ではない（広げてよいことの根拠）", () => {
  const sql021 = readFileSync(join("src/db/migrations", "021_flow_events.sql"), "utf8");
  // 「LINE 固有の識別子が NOT NULL」であれば広げるのは筋が悪い。実際は unified id。
  assertTrue(
    /user_ref\s+text\s+NOT NULL/.test(sql021),
    "user_ref は NOT NULL（前提の確認）",
  );
  assertTrue(
    /LINE userId \/ web session/.test(sql021),
    "user_ref は設計時から web を織り込んだ汎用キー（LINE 前提の意味を必須にしていない）",
  );
});

console.log("\n=== 第2段: EC 側への書き出しの無効化（判断4）===");

it("shopify-metafield の書き出しが無効化され、理由がコードに残っている", () => {
  const src = readFileSync(join("src/sync", "shopify-metafield.ts"), "utf8");
  assertTrue(
    /export const SHOPIFY_METAFIELD_SYNC_DISABLED = true;/.test(src),
    "無効化フラグが true",
  );
  assertTrue(/判断4/.test(src), "無効化した理由がコメントに残っている");
  // 削除ではなく無効化（戻せる形）= 送信処理そのものは残っている。
  assertTrue(/mutation customerUpdate\(\$input: CustomerInput!\)/.test(src), "実装は削除せず残す");
  // 3 つの入口すべてで止める（1 つでも素通りすると紐付け修正と同時に動き出す）。
  const guards = src.match(/if \(SHOPIFY_METAFIELD_SYNC_DISABLED\)/g) ?? [];
  assertTrue(guards.length >= 3, `3 つの入口すべてで止める（現在 ${guards.length} 箇所）`);
});

// ---------------------------------------------------------------------------

console.log(`\n=== 合流の穴: ${passed}/${total} passed ===`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
