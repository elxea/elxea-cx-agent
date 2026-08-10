/**
 * Unit Tests — roji 出し分け S1 割当エンジン（M4-08）
 *
 * 設計正本: roji出し分けの仕組み 設計書（S1シンプル版・Setaka 承認済み 2026-08-10）
 *   https://www.notion.so/3b870c9d064c8191b807c59c1c2a6e74  第3-1〜3-5節
 *
 * 検証範囲（設計の「必ずこの順番」を機械で固定する）:
 *   - 除外規則: 「もういらない」/ 直近3か月の重複 / 同月行は数えない / 「もういらない」は緩めない
 *   - 先取上限: 「また入れてほしい」は最大2本・外れた候補は先取りしない
 *   - tie 決定性: 同点は銘柄番号の昇順・入力順に依存しない・2 回呼んで同一
 *   - カルテ欠損時フォールバック: 全 0 点 → 番号昇順 6 本 + 理由記号 not_enough_signal
 *   - 種類の上限（4本）・候補不足の記録・重複回避の緩和・純粋性（入力を書き換えない）
 *   - 安全（アレルギー）条件は **S1 では割当に効かない**（2026-08-10 Setaka 判断）
 *
 * 使用: npx tsx tests/unit/roji-assignment-s1.test.ts
 */

import {
  S1Engine,
  S1_TEA_COUNT,
  recentTeaNumbers,
  periodIndex,
} from "../../src/lib/roji/assignment/s1-engine";
import type {
  AssignmentInput,
  Candidate,
  LedgerRow,
  RojiKarte,
} from "../../src/lib/roji/assignment/types";
import type { TeaItem } from "../../src/lib/tea-menu";
import type { ArticleItem } from "../../src/lib/journal";

let total = 0;
let passed = 0;
const failures: string[] = [];
function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  [FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertDeep(a: unknown, e: unknown, label = "") {
  const sa = JSON.stringify(a);
  const se = JSON.stringify(e);
  if (sa !== se) throw new Error(`${label}: expected ${se}, got ${sa}`);
}

// 実タグ値（next-cup.test.ts と一致・2026-07-17 Notion スキーマ確認済み）。
const AROMA_RICH = "甘い、熟した香り | リッチ";
const BODY_FULL = "しっかりした味わい | フルボディ";

function tea(number: string, category = "緑茶", flavorProfiles: string[] = []): TeaItem {
  return {
    id: `page-${number}`,
    number,
    name: `お茶${number}`,
    category,
    flavorProfiles,
    descShort: "",
    howToBrew: "",
    temp: "",
    time: "",
    water: "",
    enjoy: "",
    story: "",
  };
}

function article(id: string, persona: ArticleItem["persona"], publishedAt: string): ArticleItem {
  return {
    id,
    title: `記事${id}`,
    url: `https://example.test/${id}`,
    excerpt: "",
    thumbnailUrl: "",
    persona,
    targetLayer: null,
    tags: [],
    publishedAt,
  };
}

const teaCandidates = (...teas: TeaItem[]): Candidate[] => teas.map((t) => ({ kind: "tea", tea: t }));

/** 番号だけの候補列（連番）。 */
function teaSeries(numbers: string[], category = "緑茶"): Candidate[] {
  return teaCandidates(...numbers.map((n) => tea(n, category)));
}

const EMPTY_KARTE: RojiKarte = { persona: null, tasteProfile: null };

function input(over: Partial<AssignmentInput> = {}): AssignmentInput {
  return {
    period: "2026-09",
    karte: EMPTY_KARTE,
    candidates: [],
    recentLedger: [],
    ...over,
  };
}

const engine = new S1Engine();
const nums = (r: { teas: Array<{ number: string }> }) => r.teas.map((t) => t.number);

// ---------------------------------------------------------------------------
// 期間ヘルパ
// ---------------------------------------------------------------------------

it("periodIndex: YYYY-MM を通し月に変換し、形式外は null", () => {
  assertEqual(periodIndex("2026-09")! - periodIndex("2026-08")!, 1, "隣月");
  assertEqual(periodIndex("2026-01")! - periodIndex("2025-12")!, 1, "年跨ぎ");
  assertEqual(periodIndex("2026-13"), null, "月が範囲外");
  assertEqual(periodIndex("202609"), null, "区切り無し");
});

it("recentTeaNumbers: 直近Nか月だけを拾い、対象月と未来の行は数えない", () => {
  const rows: LedgerRow[] = [
    { period: "2026-09", teas: [{ number: "10000" }] }, // 対象月そのもの（再実行時の自分の行）
    { period: "2026-08", teas: [{ number: "10001" }] },
    { period: "2026-06", teas: [{ number: "10003" }] },
    { period: "2026-05", teas: [{ number: "10004" }] }, // 4 か月前 → 範囲外
    { period: "壊れた", teas: [{ number: "10009" }] },
  ];
  const got = [...recentTeaNumbers(rows, "2026-09", 3)].sort();
  assertDeep(got, ["10001", "10003"], "直近3か月");
  assertDeep([...recentTeaNumbers(rows, "2026-09", 1)], ["10001"], "直近1か月");
});

// ---------------------------------------------------------------------------
// 除外規則（順1）
// ---------------------------------------------------------------------------

it("除外: 「もういらない」は候補から外れ、理由 none_of が残る", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801", "11901"]),
      karte: { ...EMPTY_KARTE, teaRequests: { noneOf: ["11301"] } },
    }),
  );
  assert(!nums(res).includes("11301"), "「もういらない」が入っていない");
  assertEqual(res.teas.length, S1_TEA_COUNT, "6 本");
  assert(
    res.excluded.some((e) => e.ref.number === "11301" && e.reason === "none_of"),
    "理由 none_of が台帳向けに残る",
  );
});

it("除外: 直近3か月に送ったお茶は外れ、4か月前のものは戻ってくる", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801", "11901"]),
      recentLedger: [
        { period: "2026-08", teas: [{ number: "11301" }] },
        { period: "2026-05", teas: [{ number: "11401" }] }, // 4 か月前 → 対象外
      ],
    }),
  );
  assert(!nums(res).includes("11301"), "直近3か月のものは外れる");
  assert(nums(res).includes("11401"), "4か月前のものは候補に残る");
  assert(
    res.excluded.some((e) => e.ref.number === "11301" && e.reason === "recent_duplicate"),
    "理由 recent_duplicate",
  );
});

it("除外: 対象月と同じ月の台帳行は数えない（再実行しても結果が変わらない）", () => {
  const base = input({
    candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801"]),
  });
  const first = engine.assign(base);
  // 1 回目の結果を台帳に書いた状態で、同じ月をもう一度流す。
  const second = engine.assign({
    ...base,
    recentLedger: [{ period: "2026-09", teas: first.teas }],
  });
  assertDeep(nums(second), nums(first), "同月の自分の行で自分を除外しない");
});

it("除外: 候補が足りないとき重複回避は3か月→1か月に緩むが、「もういらない」は緩まない", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries([
        "11301",
        "11401",
        "11501",
        "11601",
        "11701",
        "11801",
        "11901",
        "12001",
      ]),
      karte: { ...EMPTY_KARTE, teaRequests: { noneOf: ["11901"] } },
      recentLedger: [
        { period: "2026-08", teas: [{ number: "11301" }] },
        { period: "2026-07", teas: [{ number: "11401" }] },
      ],
    }),
  );
  // noneOf(11901) 除外で 6 本、うち 2 本が直近3か月 → 4 本しか残らないので 1 か月へ緩める。
  assertEqual(res.teas.length, S1_TEA_COUNT, "緩めて 6 本");
  assert(!nums(res).includes("11901"), "「もういらない」は緩和後も外れたまま");
  assert(!nums(res).includes("11301"), "直近1か月のものは緩和後も外れる");
  assert(nums(res).includes("11401"), "2か月前のものは緩和で戻る");
  assertEqual(res.shortage?.code, "recent_window_relaxed", "緩めたことを締め記録へ");
  assertEqual(res.shortage?.relaxedRecentMonths, 1, "緩めた月数");
});

it("除外: 緩めても足りなければ本数を減らし、候補不足として記録する（黙って埋めない）", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries(["11301", "11401", "11501", "11601"]),
      karte: { ...EMPTY_KARTE, teaRequests: { noneOf: ["11601"] } },
      recentLedger: [{ period: "2026-08", teas: [{ number: "11301" }] }],
    }),
  );
  assertDeep(nums(res), ["11401", "11501"], "残った 2 本だけ");
  assertEqual(res.shortage?.code, "candidate_shortage", "候補不足の記録");
  assertEqual(res.shortage?.delivered, 2, "実際の本数");
  assertEqual(res.shortage?.requested, S1_TEA_COUNT, "求めた本数");
});

it("除外: 安全（アレルギー）の申告は S1 では割当に効かない（2026-08-10 判断）", () => {
  const withSafety = engine.assign(
    input({
      candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801"]),
      karte: {
        ...EMPTY_KARTE,
        // カルテには記録され続けるが、S1 の割当は読まない。
        ...({ safety: { tags: ["allergy", "caffeine_sensitive"] } } as Record<string, unknown>),
      } as RojiKarte,
    }),
  );
  const without = engine.assign(
    input({ candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801"]) }),
  );
  assertDeep(nums(withSafety), nums(without), "安全申告の有無で結果が変わらない");
});

// ---------------------------------------------------------------------------
// 先取り（順2）
// ---------------------------------------------------------------------------

it("先取: 「また入れてほしい」は点数を見ずに先頭へ入り、上限は 2 本（依頼の新しい順）", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries([
        "11301",
        "11401",
        "11501",
        "11601",
        "11701",
        "11801",
        "11901",
        "12001",
        "12101",
      ]),
      karte: {
        ...EMPTY_KARTE,
        // 追記順（末尾が最新）。番号の大きい＝点が同じなら後回しになる 3 本を希望。
        teaRequests: { moreOf: ["12101", "12001", "11901"] },
      },
    }),
  );
  assertDeep(nums(res).slice(0, 2), ["11901", "12001"], "新しい依頼から 2 本を先取り");
  assert(!nums(res).includes("12101"), "いちばん古い希望は先取りしない（上限 2 本）");
  assertEqual(res.reasonKey, "requested_more", "理由記号は希望優先");
  const pre = res.breakdown.filter((b) => b.preselected);
  assertEqual(pre.length, 2, "内訳でも先取りは 2 件");
  assert(pre.every((b) => b.rank === 0 && b.picked), "先取りは順位を持たない（rank=0）");
});

it("優先順位: 「もういらない」は「また入れてほしい」に勝つ（同じ銘柄が両方にある）", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801", "11901"]),
      karte: {
        ...EMPTY_KARTE,
        teaRequests: { moreOf: ["11801", "11901"], noneOf: ["11901"] },
      },
    }),
  );
  assert(!nums(res).includes("11901"), "「もういらない」が絶対条件として勝つ");
  assert(
    res.excluded.some((e) => e.ref.number === "11901" && e.reason === "none_of"),
    "理由は none_of",
  );
  assertEqual(nums(res)[0], "11801", "競合していない希望は先取りされる");
});

it("優先順位: 「また入れてほしい」は直近3か月の重複回避に勝つ（最大 2 本まで）", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801", "11901"]),
      karte: { ...EMPTY_KARTE, teaRequests: { moreOf: ["11801", "11901"] } },
      // 希望した 2 本とも先月送っている（運用初期はこれが普通に起きる）。
      recentLedger: [{ period: "2026-08", teas: [{ number: "11801" }, { number: "11901" }] }],
    }),
  );
  assertDeep(nums(res).slice(0, 2), ["11901", "11801"], "直近に送っていても希望が入る");
  assertEqual(res.reasonKey, "requested_more", "約束が発火する");
  assert(
    !res.excluded.some((e) => ["11801", "11901"].includes(e.ref.number)),
    "先取りしたものは「選ばなかった」側に出さない",
  );
});

it("優先順位: 希望が 3 本以上あっても採る 2 本は一意（同じ入力なら同じ出力）", () => {
  const base = input({
    candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801", "11901"]),
    karte: { ...EMPTY_KARTE, teaRequests: { moreOf: ["11301", "11401", "11501", "11601"] } },
  });
  const first = engine.assign(base);
  const second = engine.assign(base);
  assertDeep(nums(first).slice(0, 2), ["11601", "11501"], "末尾（最新）から 2 本");
  assertDeep(second, first, "再実行で完全に同一");
});

it("優先順位: 希望に同じ銘柄が重複していても新しい方で数え、上限 2 本を超えない", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801"]),
      karte: { ...EMPTY_KARTE, teaRequests: { moreOf: ["11301", "11401", "11301"] } },
    }),
  );
  const pre = res.breakdown.filter((b) => b.preselected).map((b) => b.ref.number);
  assertDeep(pre, ["11301", "11401"], "重複は 1 件に畳み、新しい順で 2 本");
});

it("先取: 希望した銘柄が今月の候補に無ければ黙って飛ばす（落ちない）", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801"]),
      karte: { ...EMPTY_KARTE, teaRequests: { moreOf: ["99999"] } },
    }),
  );
  assertEqual(res.teas.length, S1_TEA_COUNT, "6 本");
  assertEqual(res.reasonKey, "not_enough_signal", "先取り 0 件・点も 0 なら手がかり不足");
});

// ---------------------------------------------------------------------------
// 並べ替え（順3・順4）
// ---------------------------------------------------------------------------

it("tie 決定性: 同点は銘柄番号の昇順で 6 本・入力順に依存しない・再実行で同一", () => {
  const numbers = ["11901", "11301", "11801", "11401", "11701", "11501", "11601"];
  const res = engine.assign(input({ candidates: teaSeries(numbers) }));
  assertDeep(nums(res), ["11301", "11401", "11501", "11601", "11701", "11801"], "番号昇順 6 本");

  const shuffled = engine.assign(input({ candidates: teaSeries([...numbers].reverse()) }));
  assertDeep(nums(shuffled), nums(res), "入力順を変えても同じ");

  const again = engine.assign(input({ candidates: teaSeries(numbers) }));
  assertDeep(again, res, "同じ入力なら結果オブジェクトごと同一");
});

it("並べ替え: 既存 karteAffinity の点が高い銘柄が先に入り、理由記号は taste_match", () => {
  // 種類の上限（4本）に当たらない構成にして、点数だけで溢れる様子を見る。
  const candidates = teaCandidates(
    tea("11301", "緑茶"),
    tea("11401", "緑茶"),
    tea("11501", "緑茶"),
    tea("11601", "緑茶"),
    tea("11701", "緑茶"),
    tea("40101", "青茶"), // 番号は大きいがカルテで +2
    tea("40201", "青茶"),
  );
  const karte: RojiKarte = {
    persona: null,
    tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: [], scenePref: null },
  };
  const res = engine.assign(input({ candidates, karte }));
  assertDeep(nums(res).slice(0, 2), ["40101", "40201"], "好きなカテゴリ一致が先頭");
  assertEqual(res.reasonKey, "taste_match", "点が付いたので手がかりあり");
  assert(!nums(res).includes("11701"), "点が同じ最後尾は 6 本から溢れる");
  assert(
    res.excluded.some((e) => e.ref.number === "11701" && e.reason === "score_rank"),
    "溢れた理由は score_rank（外したのではなく選ばれなかった）",
  );
});

it("種類の上限: 同じ種類は 4 本まで。次点の別の種類へ譲る", () => {
  const candidates = teaCandidates(
    tea("11301", "緑茶"),
    tea("11401", "緑茶"),
    tea("11501", "緑茶"),
    tea("11601", "緑茶"),
    tea("11701", "緑茶"),
    tea("11801", "緑茶"),
    tea("40101", "青茶"),
    tea("40201", "青茶"),
  );
  const res = engine.assign(input({ candidates }));
  const picked = nums(res);
  assertEqual(picked.filter((n) => n.startsWith("1")).length, 4, "緑茶は 4 本まで");
  assertDeep(picked.slice(4), ["40101", "40201"], "残り 2 本は別の種類");
  assert(
    res.excluded.some((e) => e.ref.number === "11701" && e.reason === "category_cap"),
    "譲った理由は category_cap",
  );
});

it("種類の上限: 別の種類が無ければ本数を優先して 6 本埋める", () => {
  const res = engine.assign(
    input({ candidates: teaSeries(["11301", "11401", "11501", "11601", "11701", "11801"]) }),
  );
  assertEqual(res.teas.length, S1_TEA_COUNT, "同じ種類でも 6 本");
  assertEqual(res.shortage, null, "本数が揃えば締め記録に書くことはない");
  assert(!res.excluded.some((e) => e.reason === "category_cap"), "譲り先が無いので category_cap なし");
});

// ---------------------------------------------------------------------------
// カルテ欠損時フォールバック（設計 3-2）
// ---------------------------------------------------------------------------

it("カルテ欠損: 未診断・好み空は全 0 点 → 番号昇順 6 本 + not_enough_signal", () => {
  const numbers = ["11301", "11401", "11501", "11601", "11701", "11801", "11901"];
  const res = engine.assign(input({ candidates: teaSeries(numbers), karte: EMPTY_KARTE }));
  assertDeep(nums(res), numbers.slice(0, 6), "番号昇順 6 本");
  assertEqual(res.reasonKey, "not_enough_signal", "「まだ手がかりが少ない」");
  assert(res.breakdown.every((b) => b.score === 0), "全 0 点");
});

it("カルテ欠損: teaRequests / windowAffinity が無くても落ちない", () => {
  const res = engine.assign(
    input({
      candidates: teaSeries(["11301", "11401"]),
      karte: { persona: "serenity", tasteProfile: null },
    }),
  );
  assertEqual(res.teas.length, 2, "候補ぶんだけ返る");
  assertEqual(res.shortage?.code, "candidate_shortage", "足りなければ記録する");
});

it("カルテ欠損: persona だけあるとき既存の弱い傾きが効く（新しい軸は足していない）", () => {
  const res = engine.assign(
    input({
      candidates: teaCandidates(
        tea("11301", "緑茶"),
        tea("11401", "緑茶", [AROMA_RICH, BODY_FULL]), // serenity → aroma rich に +1
      ),
      karte: { persona: "serenity", tasteProfile: null },
    }),
  );
  assertEqual(nums(res)[0], "11401", "傾きが一致する銘柄が先頭");
  assertEqual(res.reasonKey, "taste_match", "点が付いた");
});

// ---------------------------------------------------------------------------
// 読みもの・純粋性
// ---------------------------------------------------------------------------

it("読みもの: 好みタイプで一次マッチし、合うものが無ければ新しい順（行き止まりにしない）", () => {
  const articles: Candidate[] = [
    { kind: "article", article: article("a-old", "explorer", "2026-01-01") },
    { kind: "article", article: article("a-new", "explorer", "2026-08-01") },
    { kind: "article", article: article("a-match", "serenity", "2025-01-01") },
  ];
  const matched = engine.assign(
    input({ candidates: articles, karte: { persona: "serenity", tasteProfile: null } }),
  );
  assertDeep(
    matched.articles.map((a) => a.id),
    ["a-match"],
    "好みタイプ一致を採る",
  );

  const noMatch = engine.assign(input({ candidates: articles, karte: EMPTY_KARTE }));
  assertDeep(
    noMatch.articles.map((a) => a.id),
    ["a-new"],
    "合うものが無ければ新しい順",
  );

  const none = engine.assign(input({ candidates: teaSeries(["11301"]) }));
  assertDeep(none.articles, [], "記事ゼロでも落ちない");
});

it("純粋性: 入力オブジェクトを書き換えない（同じ入力を使い回せる）", () => {
  const inp = input({
    candidates: teaSeries(["11901", "11301", "11401", "11501", "11601", "11701", "11801"]),
    karte: { ...EMPTY_KARTE, teaRequests: { moreOf: ["11901"], noneOf: ["11801"] } },
    recentLedger: [{ period: "2026-08", teas: [{ number: "11301" }] }],
  });
  const snapshot = JSON.stringify(inp);
  engine.assign(inp);
  assertEqual(JSON.stringify(inp), snapshot, "入力が不変");
});

it("結果: 選ばなかった候補はすべて理由付きで返る（あとから検証できる）", () => {
  const numbers = ["11301", "11401", "11501", "11601", "11701", "11801", "11901"];
  const res = engine.assign(
    input({
      candidates: teaSeries(numbers),
      karte: { ...EMPTY_KARTE, teaRequests: { noneOf: ["11301"] } },
      recentLedger: [{ period: "2026-08", teas: [{ number: "11401" }] }],
    }),
  );
  const accounted = new Set([...nums(res), ...res.excluded.map((e) => e.ref.number)]);
  assertEqual(accounted.size, numbers.length, "候補は全て「選んだ」か「理由付きで選ばなかった」");
});

console.log("\n============================================================");
console.log("roji assignment S1 Test Results");
console.log("============================================================");
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
if (failures.length > 0) process.exit(1);
