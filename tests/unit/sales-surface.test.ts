/**
 * Unit Tests -- sales-surface（売り込み面の機能ゲート）
 *
 * 検証対象（機能定義 v1.5 3-2/3-5・Phase 0 タスク4「売り込み系の機能を外す」）:
 *   (a) フラグ判定: 既定 OFF（未設定・空・"false"・"1"・"TRUE" はすべて OFF。"true" だけ ON）
 *   (b) ツール露出: 既定では recommend_product / create_cart_link を AI に渡さない
 *   (c) System Prompt: 既定では商品カード・購入導線の指示を含まず、「買う導線を置かない」を含む
 *   (d) ④定期便の常設枠: 既定では未利用の方へ案内を出さない（中立の受け皿 1 通で着地）
 *   (e) 中立応答の文面: 便益訴求・煽り語・購入ボタンを含まない
 *   (f) Quick Reply: 既定では売り込みツール由来の Quick Reply を出さない（fail-closed）
 *   (g) ペルソナ断片: どのペルソナでも商品提案の指示を持たない（未判定を含む）
 *
 * 使用方法: npx tsx tests/unit/sales-surface.test.ts
 */

import {
  isSalesSurfaceEnabled,
  isSalesTool,
  SALES_TOOL_NAMES,
  SALES_TOOL_DISABLED_RESULT,
  EC_SITE_URL,
} from "../../src/lib/sales-surface";
import { AGENT_TOOLS, SALES_TOOLS, agentTools } from "../../src/agent/tools";
import {
  SYSTEM_PROMPT,
  systemPrompt,
  buildPersonaPromptFragment,
} from "../../src/agent/system-prompt";
import { generateQuickReplies } from "../../src/agent/core";
import {
  decideSubscriptionResponse,
  buildSubscriptionInquiryReply,
  buildSubscriptionMessage,
} from "../../src/lib/menu-actions";

let total = 0,
  passed = 0,
  failed = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${name}: ${msg}`);
    failures.push({ name, error: msg });
  }
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const OFF = {} as const;
const ON = { SALES_SURFACE_ENABLED: "true" } as const;
const toolNames = (env: { SALES_SURFACE_ENABLED?: string }) => agentTools(env).map((t) => t.name);

console.log("\n--- (a) フラグ判定は既定 OFF・\"true\" だけ ON ---");

it("未設定 / undefined / null は OFF（fail-closed）", () => {
  assertEqual(isSalesSurfaceEnabled(OFF), false, "未設定");
  assertEqual(isSalesSurfaceEnabled(undefined), false, "undefined");
  assertEqual(isSalesSurfaceEnabled(null), false, "null");
});

it("\"true\" 以外の真っぽい値も OFF", () => {
  for (const v of ["", "false", "1", "TRUE", "True", "yes", "on"]) {
    assertEqual(
      isSalesSurfaceEnabled({ SALES_SURFACE_ENABLED: v }),
      false,
      `SALES_SURFACE_ENABLED="${v}"`,
    );
  }
});

it("\"true\" のときだけ ON", () => {
  assertEqual(isSalesSurfaceEnabled(ON), true, "true");
});

console.log("\n--- (b) ツール露出: 既定では売り込みツールを AI に渡さない ---");

it("既定では recommend_product / create_cart_link が露出しない", () => {
  const names = toolNames(OFF);
  assert(!names.includes("recommend_product"), `商品カードの道具が露出: ${names.join(",")}`);
  assert(!names.includes("create_cart_link"), `購入ボタンの道具が露出: ${names.join(",")}`);
});

it("既定でも既存の非売り込みツールは維持される（退行防止）", () => {
  const names = toolNames(OFF);
  for (const n of ["escalate_to_human", "lookup_my_orders", "get_order_detail"]) {
    assert(names.includes(n), `${n} が消えている: ${names.join(",")}`);
  }
});

it("フラグ ON のときだけ売り込みツールが合流する（温存されており復活できる）", () => {
  const names = toolNames(ON);
  assert(names.includes("recommend_product"), "recommend_product が復活しない");
  assert(names.includes("create_cart_link"), "create_cart_link が復活しない");
  assertEqual(agentTools(ON).length, AGENT_TOOLS.length + SALES_TOOLS.length, "合流後の件数");
});

it("SALES_TOOL_NAMES と SALES_TOOLS の定義が一致する（片方だけ増える事故の防止）", () => {
  const defined = SALES_TOOLS.map((t) => t.name).sort();
  const listed = [...SALES_TOOL_NAMES].sort();
  assertEqual(JSON.stringify(defined), JSON.stringify(listed), "SALES_TOOLS vs SALES_TOOL_NAMES");
});

it("isSalesTool が売り込みツールだけを true と判定する", () => {
  assertEqual(isSalesTool("recommend_product"), true, "recommend_product");
  assertEqual(isSalesTool("create_cart_link"), true, "create_cart_link");
  assertEqual(isSalesTool("escalate_to_human"), false, "escalate_to_human");
  assertEqual(isSalesTool("get_order_detail"), false, "get_order_detail");
});

it("実行拒否時の文言は購入導線を EC サイトへ寄せ、偽の約束をしない", () => {
  assert(SALES_TOOL_DISABLED_RESULT.includes(EC_SITE_URL), "EC サイトの受け皿が示されていない");
  assert(!SALES_TOOL_DISABLED_RESULT.includes("カートに入れ"), "カート追加を示唆している");
});

console.log("\n--- (c) System Prompt: 既定で購入導線の指示を持たない ---");

it("既定の System Prompt に売り込みツールの使用指示が無い", () => {
  const p = systemPrompt(OFF);
  assert(!p.includes("recommend_product"), "recommend_product の指示が残っている");
  assert(!p.includes("create_cart_link"), "create_cart_link の指示が残っている");
});

it("既定の System Prompt に「買う導線を置かない」が常設されている", () => {
  const p = systemPrompt(OFF);
  assert(p.includes("買う導線を置かない"), "売り込み禁止の節が無い");
  assert(p.includes(EC_SITE_URL), "購入の受け皿（EC サイト）の案内が無い");
});

it("既定は SYSTEM_PROMPT と完全一致（プロンプトキャッシュを壊さない）", () => {
  assertEqual(systemPrompt(OFF), SYSTEM_PROMPT, "既定のプロンプト");
});

it("フラグ ON のときだけ商品カードの指示が足される（温存の確認）", () => {
  const p = systemPrompt(ON);
  assert(p.includes("recommend_product"), "ON でも商品カードの指示が出ない");
  assert(p.startsWith(SYSTEM_PROMPT), "本体プロンプトが差し替わっている");
});

console.log("\n--- (d) ④定期便の常設枠: 既定では案内を出さない ---");

it("既定: 未連携の方は連携ボタンのファネルに乗らない（inquiry で着地）", () => {
  assertEqual(
    decideSubscriptionResponse({ salesEnabled: false, linked: false, isSubscriber: false }),
    "inquiry",
    "未連携・売り込み面 OFF",
  );
});

it("既定: 連携済み非定期便の方にも紹介を出さない（inquiry で着地）", () => {
  assertEqual(
    decideSubscriptionResponse({ salesEnabled: false, linked: true, isSubscriber: false }),
    "inquiry",
    "連携済み非定期便・売り込み面 OFF",
  );
});

it("既定でも利用中の方へのお手続き案内は維持する（購入後サポートは売り込みではない）", () => {
  assertEqual(
    decideSubscriptionResponse({ salesEnabled: false, linked: true, isSubscriber: true }),
    "subscriber",
    "定期便利用中・売り込み面 OFF",
  );
});

it("フラグ ON では従来の出し分けに戻る（退行なく復活できる）", () => {
  assertEqual(
    decideSubscriptionResponse({ salesEnabled: true, linked: true, isSubscriber: false }),
    "generic",
    "連携済み非定期便・ON",
  );
  assertEqual(
    decideSubscriptionResponse({ salesEnabled: true, linked: false, isSubscriber: false }),
    "generic_with_linkage",
    "未連携・ON",
  );
  assertEqual(
    decideSubscriptionResponse({ salesEnabled: true, linked: true, isSubscriber: true }),
    "subscriber",
    "定期便利用中・ON",
  );
});

console.log("\n--- (e) 中立応答の文面 ---");

it("中立応答に便益訴求・煽り語・購入ボタンの語が無い", () => {
  const m = buildSubscriptionInquiryReply();
  for (const ng of [
    "選ぶ手間なく",
    "いちばんおいしい",
    "おすすめ",
    "今だけ",
    "残りわずか",
    "お得",
    "購入",
    "カート",
  ]) {
    assert(!m.includes(ng), `中立応答に売り込み語「${ng}」が含まれる`);
  }
});

it("中立応答は問い合わせの受け皿として案内先を 1 つだけ示す", () => {
  const m = buildSubscriptionInquiryReply();
  const urls = m.match(/https:\/\/[^\s]+/g) ?? [];
  assertEqual(urls.length, 1, "案内先 URL は 1 つ");
  assert(m.length <= 160, `1 通が長すぎる（${m.length} 文字）`);
});

it("従来の generic 紹介文は温存されている（復活可能・削除していない）", () => {
  assert(
    buildSubscriptionMessage("generic").includes("選ぶ手間なく"),
    "generic 紹介文が失われている",
  );
});

console.log("\n--- (f) Quick Reply の fail-closed ---");

// usedTools は実行可否と無関係に積まれる（モデルが呼んだ事実がそのまま入る）。
// executeTool 側で実行を拒否しても Quick Reply だけが顧客に出る、という抜けを塞ぐ。
it("OFF なら create_cart_link 由来の Quick Reply を出さない", () => {
  assertEqual(
    generateQuickReplies(["create_cart_link"], false, false).length,
    0,
    "OFF でカート導線の Quick Reply が出ている",
  );
});

it("OFF なら recommend_product 由来の Quick Reply を出さない", () => {
  assertEqual(
    generateQuickReplies(["recommend_product"], false, false).length,
    0,
    "OFF で商品提案の Quick Reply が出ている",
  );
});

it("OFF の Quick Reply 全体に購入導線・煽り語が出ない", () => {
  const labels = [
    ...generateQuickReplies(["create_cart_link", "recommend_product"], false, false),
    ...generateQuickReplies(["lookup_my_orders"], false, false),
    ...generateQuickReplies([], false, false),
    ...generateQuickReplies([], true, false),
  ]
    .map((q) => `${q.label} ${q.text}`)
    .join(" ");
  for (const ng of ["購入", "カート", "おすすめ", "お得", "今だけ"]) {
    assert(!labels.includes(ng), `OFF の Quick Reply に売り込み語「${ng}」が含まれる`);
  }
});

it("OFF でも売り込み以外（注文照会・エスカレーション）の Quick Reply は残る", () => {
  assert(
    generateQuickReplies(["get_order_detail"], false, false).length > 0,
    "注文照会の Quick Reply まで消えている",
  );
  assert(
    generateQuickReplies(["lookup_my_orders"], false, false).length > 0,
    "注文照会の Quick Reply まで消えている",
  );
  assertEqual(
    generateQuickReplies(["create_cart_link"], true, false).length,
    1,
    "エスカレーション時の Quick Reply が失われている",
  );
});

it("売り込みツールが積まれていても OFF なら注文照会の分岐に落ちる", () => {
  // 売り込み分岐を「早期 return で塞ぐ」のではなく「条件から外す」ことの確認。
  const qr = generateQuickReplies(["recommend_product", "lookup_my_orders"], false, false);
  assert(qr.length > 0, "後続の注文照会分岐に落ちていない");
  assert(
    qr.every((q) => !`${q.label}${q.text}`.includes("購入")),
    "購入導線が混ざっている",
  );
});

it("ON なら従来の Quick Reply は温存されている（復活可能・削除していない）", () => {
  assert(
    generateQuickReplies(["create_cart_link"], false, true).length > 0,
    "ON でカート導線の Quick Reply が失われている",
  );
  assert(
    generateQuickReplies(["recommend_product"], false, true).some((q) =>
      q.text.includes("購入"),
    ),
    "ON で商品提案の Quick Reply が失われている",
  );
});

console.log("\n--- (g) ペルソナ断片に売り込み指示が無い ---");

// 未判定は新規ユーザーの既定状態＝最も多くの人が通る経路。
// 断片が「商品提案を中心に」と言うと、同じ system メッセージ内の
// 「買う導線を置かない / 煽り・評価の言葉を使わない」と正面から矛盾する。
const PERSONAS = ["serenity", "explorer", "sensory"] as const;

it("未判定の断片に商品提案の指示が無い", () => {
  const f = buildPersonaPromptFragment(null);
  for (const ng of ["商品提案", "ベストセラー", "定番品", "おすすめ", "購入"]) {
    assert(!f.includes(ng), `未判定の断片に売り込み指示「${ng}」が含まれる`);
  }
});

it("全ペルソナ断片に商品提案・勧誘の指示が無い（1 体前提で方針を揃える）", () => {
  for (const p of PERSONAS) {
    const f = buildPersonaPromptFragment(p);
    for (const ng of ["提案", "勧め", "おすすめ", "購入", "優先"]) {
      assert(!f.includes(ng), `${p} の断片に売り込み指示「${ng}」が含まれる`);
    }
  }
});

it("全ペルソナ断片に煽り語（希少性・緊急性）が無い", () => {
  for (const p of PERSONAS) {
    const f = buildPersonaPromptFragment(p);
    // serenity の「急かす表現（「今すぐ」「限定」）は避ける」は禁止の明示なので対象外にする。
    const directives = f
      .split("\n")
      .filter((l) => !l.includes("避け"))
      .join("\n");
    for (const ng of ["季節限定", "今だけ", "残りわずか", "お得"]) {
      assert(!directives.includes(ng), `${p} の断片に煽り語「${ng}」が含まれる`);
    }
  }
});

it("ペルソナ断片は口調・話題の調整として機能し続ける（空にしていない）", () => {
  for (const p of PERSONAS) {
    const f = buildPersonaPromptFragment(p);
    assert(f.includes("口調"), `${p} の断片から口調指示が失われている`);
    assert(f.includes("話題"), `${p} の断片から話題指示が失われている`);
  }
  assert(
    buildPersonaPromptFragment(null).includes("ニュートラル"),
    "未判定の中立指示が失われている",
  );
});

console.log(
  `\n=== sales-surface: ${passed}/${total} passed, ${failed} failed ===`,
);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
