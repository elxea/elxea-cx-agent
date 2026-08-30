/**
 * Unit Tests — 連携済みの人の記憶否認（B-1）とチャネルの言い分け（B-3）
 *
 * トレース済みの事実:
 *   routes/line.ts の履歴ゲートは `identity.isLinked || canonical.linked`（= crossChannel）なのに、
 *   runAgent へ渡すフラグだけが `identity.isLinked` だった。subject_links でしか連携していない人
 *   （LIFF / LINE 純正 Account Link 経由）は履歴がプロンプトに入るのに「連携済み・以前の会話内容を
 *   自然に参照してください」の指示が出ず、AI が目の前の履歴を否認していた。
 *
 * 検証:
 *   (a) 配線 break-proof: routes/line.ts の runAgent 2 か所が履歴ゲートと同じ crossChannel を渡す
 *   (b) 連携済み指示: buildCustomerContext が isLinked=true のときだけ参照指示を出す
 *       （カルテがまだ無い人＝連携直後の人にも出る。ここが B-1 の実害地点）
 *   (c) B-3: 履歴が複数チャネルにまたがるときだけチャネル印を付け、印の読み方を説明する
 *   (d) SEC-3 非回帰: web 側の fail-closed（isLinked && trusted）は緩めない
 *
 * 応答本文まで含む実 webhook 経路の固定は tests/hermetic/flow20-crosschannel-linked-recall.test.ts
 * が担う（本ファイルは workerd では読めないソース検査と純粋関数を担当する）。
 *
 * 使用方法: npx tsx tests/unit/crosschannel-linked-recall.test.ts
 */

import { readFileSync } from "node:fs";
import {
  buildCustomerContext,
  buildCrossChannelNote,
  buildHistoryMessages,
  channelLabel,
  historyChannels,
  historySpansChannels,
} from "../../src/agent/core";
import { readResolution } from "../../src/lib/cdp/canonical";
import { crossChannelHistoryAllowed } from "../../src/routes/web";

let total = 0,
  passed = 0,
  failed = 0;
const failures: Array<{ name: string; error: string }> = [];

function describe(name: string, fn: () => void) {
  console.log(`\n--- ${name} ---`);
  fn();
}

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
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeep<T>(actual: T, expected: T, label = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const LINE_SRC = readFileSync(new URL("../../src/routes/line.ts", import.meta.url), "utf-8");

/** 別チャネルにまたがる履歴（連携済みの人が見ているもの）。 */
const MIXED_HISTORY = [
  { role: "user" as const, content: "まろやかなほうじ茶が好みです。", channel: "web" },
  { role: "assistant" as const, content: "承知しました。", channel: "web" },
  { role: "user" as const, content: "水出しで淹れます。", channel: "line" },
];

/** 単一チャネルの履歴（大多数の人が見ているもの）。 */
const SINGLE_HISTORY = [
  { role: "user" as const, content: "水出しで淹れます。", channel: "line" },
  { role: "assistant" as const, content: "承知しました。", channel: "line" },
];

describe("(a) 配線 break-proof — runAgent は履歴ゲートと同じ crossChannel を受け取る", () => {
  it("履歴ゲートが canonical 解決を含む（★11 の恒久解が残っている）", () => {
    assert(
      LINE_SRC.includes("const crossChannel = identity.isLinked || canonical.linked;"),
      "履歴ゲート（identity.isLinked || canonical.linked）が見つからない",
    );
  });

  it("runAgent へ渡す isLinked は crossChannel（テキスト・画像の 2 か所とも）", () => {
    const sites = LINE_SRC.match(/\{\s*isLinked:\s*[A-Za-z0-9_.]+/g) ?? [];
    assert(sites.length >= 2, `runAgent へ渡す isLinked の指定が 2 か所見つからない: ${sites.length}`);
    for (const site of sites) {
      assert(
        /isLinked:\s*crossChannel/.test(site),
        `履歴ゲートと違うフラグを渡している（B-1 退行）: ${site}`,
      );
    }
  });

  it("旧配線（isLinked: identity.isLinked）が 1 か所も残っていない", () => {
    assert(
      !/isLinked:\s*identity\.isLinked/.test(LINE_SRC),
      "旧配線 isLinked: identity.isLinked が残っている（B-1 退行）",
    );
  });

  it("subject_links だけの連携でも canonical は linked=true を返す（B-1 の前提）", () => {
    const resolution = readResolution({
      found: true,
      canonical_id: "01UNITCANONICALB1000000000",
      member_count: 2,
      link_count: 1,
      identifier_values: ["Uunit0000", "sess-unit-0000"],
      truncated: false,
    });
    assertEqual(resolution.resolved, true, "canonical 解決が resolved=false に倒れている");
    assertEqual(resolution.linked, true, "link 1 本なのに linked=false");
    assertDeep(resolution.userRefs, ["Uunit0000", "sess-unit-0000"], "読む user_id が足りない");
  });
});

describe("(b) 連携済み指示 — カルテが無くても「以前の会話を参照」を出す", () => {
  it("連携済み・カルテ未作成: 参照指示が出る（B-1 の実害地点）", () => {
    const ctx = buildCustomerContext(null, true);
    assert(ctx.includes("アカウント連携済み"), "連携済みフラグが出ていない");
    assert(
      ctx.includes("以前の会話内容を自然に参照してください"),
      "カルテ未作成の連携済みユーザーに参照指示が出ていない（B-1 退行）",
    );
    assert(
      ctx.includes("覚えていない"),
      "「覚えていないと否定しない」という明示がない（記憶否認の再発余地）",
    );
  });

  it("未連携: 顧客データブロックを一切出さない（過剰適用しない）", () => {
    assertEqual(buildCustomerContext(null, false), "", "未連携なのに顧客データが出ている");
  });

  it("連携済み・カルテあり: 参照指示とプロファイル活用ルールが出る", () => {
    const ctx = buildCustomerContext(
      { displayName: "テスト", tasteProfile: { preferredCategories: ["hojicha"] } } as never,
      true,
    );
    assert(ctx.includes("以前の会話内容を自然に参照してください"), "参照指示が出ていない");
    assert(ctx.includes("プロファイル活用ルール"), "プロファイル活用ルールが出ていない");
  });
});

describe("(c) B-3 — チャネルを言い分けられるようにする", () => {
  it("チャネル名は内部語を漏らさない（未知チャネルはラベルを作らない）", () => {
    assertEqual(channelLabel("line"), "LINE", "LINE のラベル");
    assertEqual(channelLabel("web"), "サイトのチャット", "web のラベル");
    assertEqual(channelLabel("unknown"), null, "未知チャネルに勝手なラベルを作っている");
    assertEqual(channelLabel(undefined), null, "channel 無しにラベルを作っている");
  });

  it("履歴のチャネルを初出順で数える", () => {
    assertDeep(historyChannels(MIXED_HISTORY), ["web", "line"], "チャネルの集計");
    assertEqual(historySpansChannels(MIXED_HISTORY), true, "横断判定（複数）");
    assertEqual(historySpansChannels(SINGLE_HISTORY), false, "横断判定（単一）");
    assertEqual(historySpansChannels([]), false, "横断判定（空）");
  });

  it("横断時のみチャネル印を付ける（本文は変えない）", () => {
    const mixed = buildHistoryMessages(MIXED_HISTORY);
    assertEqual(
      mixed[0].content as string,
      "[サイトのチャット] まろやかなほうじ茶が好みです。",
      "web 発言に印が付いていない",
    );
    assertEqual(mixed[2].content as string, "[LINE] 水出しで淹れます。", "LINE 発言に印が付いていない");
    assertEqual(mixed[0].role, "user", "role が変わっている");
  });

  it("単一チャネルの人にはプロンプトを 1 文字も足さない（既存体験を動かさない）", () => {
    const single = buildHistoryMessages(SINGLE_HISTORY);
    assertEqual(single[0].content as string, "水出しで淹れます。", "単一チャネルなのに印が付いている");
    assertEqual(buildCrossChannelNote(SINGLE_HISTORY), "", "単一チャネルなのに説明が入っている");
    assertEqual(buildCrossChannelNote([]), "", "空履歴なのに説明が入っている");
  });

  it("横断時は印の読み方を説明し、印を本文に書かせない", () => {
    const note = buildCrossChannelNote(MIXED_HISTORY);
    assert(note.includes("会話履歴のチャネル表示"), "説明ブロックの見出しがない");
    assert(note.includes("サイトのチャット"), "ラベルが説明に出ていない");
    assert(note.includes("LINE"), "ラベルが説明に出ていない");
    assert(note.includes("返答本文に書いてはいけません"), "印を本文に出さない指示がない");
  });

  it("channel を持たない履歴（旧シグネチャ）でも壊れない", () => {
    const legacy = [{ role: "user" as const, content: "こんにちは" }];
    assertDeep(
      buildHistoryMessages(legacy),
      [{ role: "user", content: "こんにちは" }],
      "channel 無しの履歴が変形している",
    );
  });
});

describe("(d) SEC-3 非回帰 — web 側の fail-closed は緩めない（B-2 は意図的に現状維持）", () => {
  it("web は trusted でなければクロスチャネルを開かない", () => {
    assertEqual(crossChannelHistoryAllowed(true, true), true, "信頼経路の連携済みは開く");
    assertEqual(crossChannelHistoryAllowed(true, false), false, "session_id 一致だけで開いてはいけない");
    assertEqual(crossChannelHistoryAllowed(false, true), false, "未連携で開いてはいけない");
  });
});

console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
