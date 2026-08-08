/**
 * Unit Tests — roji 最初のアンケート（6問・全部1タップ・伸びる1行）
 *
 * 仕様の正本: roji 最初のアンケート Spec https://www.notion.so/3b570c9d064c81e6b0fcf19356e65406
 *
 * ─ 何を確かめるか ─
 *   1. 画面に出る文言が Spec と **1文字も違わない**（第2章）
 *   2. 3条件（全部1タップ / 途中でやめても成立 / 進むほど当たると分かる）が実際に成立する
 *   3. 最後の1行が Spec の例1・例3・例4 と **完全一致**する（組み立ての規則1〜3）
 *   4. **答えが器に本当に入っている**（呼んだ、ではなく、入れて読み戻して一致する）
 *   5. 禁じ手（星・点数・煽り・買う導線・比較）が画面に 1 つも無い
 *
 * 実 DB / 実ネットワークに接触しない（器の側の往復は tests/db/roji-survey.db.test.ts）。
 * 使用: npx tsx tests/unit/roji-survey.test.ts
 */

import {
  parseSurveyAction,
  planSurvey,
  planWords,
  buildSurveyState,
  buildProgressLine,
  buildFinalScreen,
  buildEstimateLine,
  buildQuestionScreen,
  buildIntroScreen,
  buildFinalScreenMessage,
  buildFixScreen,
  buildWordsScreen,
  buildQuoteScreen,
  composeUnderstanding,
  nextUnanswered,
  type SurveyAnswers,
  type SurveyEventRow,
  type SurveyState,
} from "../../src/lib/roji-survey";
import {
  QUESTIONS,
  INTRO_TEXT,
  CLOSING_TEXT,
  QUOTE_CONSENT_TEXT,
  SURVEY_TRIGGER,
  LABEL_END,
} from "../../src/lib/roji-survey-copy";
import {
  surveyKarteUpdates,
  recordSurveyKarteWith,
  SURVEY_PERSONA_WEIGHT,
  SURVEY_WORD_SOURCE,
  type SurveyKarteDeps,
} from "../../src/lib/roji-survey-record";
import type { CustomerProfile, LineUserProfile } from "../../src/lib/firestore";

let total = 0;
let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  total++;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  [PASS] ${name}`);
    })
    .catch((e) => {
      failures.push({ name, error: e instanceof Error ? e.message : String(e) });
      console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
    });
}
function assertTrue(v: boolean, label: string) {
  if (!v) throw new Error(label);
}
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected: ${b}\n  actual  : ${a}`);
}

// ---------------------------------------------------------------------------
// テスト用の「カルテ」— 書いたものを読み戻せるインメモリの器
// ---------------------------------------------------------------------------

function fakeKarte(linked: boolean) {
  const shopify: Record<string, CustomerProfile> = {};
  const line: Record<string, LineUserProfile> = {};
  const deps: SurveyKarteDeps = {
    resolveShopifyId: async (id) => (linked ? `shop-${id}` : null),
    getShopifyProfile: async (id) => shopify[id] ?? null,
    updateShopifyProfile: async (id, u) => {
      shopify[id] = { ...(shopify[id] ?? {}), ...u };
    },
    getLineProfile: async (id) => line[id] ?? null,
    updateLineProfile: async (id, u) => {
      line[id] = { ...(line[id] ?? {}), ...u };
    },
  };
  return {
    deps,
    /** 書いたあとに読み戻す（「呼んだ」ではなく「入っている」を見るための唯一の窓）。 */
    read: (lineUserId: string) => (linked ? shopify[`shop-${lineUserId}`] : line[lineUserId]),
  };
}

/**
 * 出来事の置き場（項目31）に相当するインメモリの列。
 * 実際の実装と同じく **ここから状態を読み直す**（会話状態を持たない）。
 */
function fakeEvents() {
  const rows: SurveyEventRow[] = [];
  let t = Date.parse("2026-08-08T00:00:00Z");
  return {
    rows,
    push(eventName: string, step?: string, value?: string) {
      t += 1000;
      rows.push({
        event_name: eventName,
        step: step ?? null,
        value: value ?? null,
        created_at: new Date(t).toISOString(),
      });
    },
    state(): SurveyState {
      return buildSurveyState(rows, t + 1000);
    },
  };
}

/**
 * 1 人分のアンケートを、実装と同じ順序で最後まで通す（純粋な部分だけ）。
 * 返信・出来事・カルテのすべてを、実装の plan に従って器へ流し込む。
 */
async function runFlow(
  taps: string[],
  opts: { linked?: boolean } = {},
): Promise<{
  screens: Array<{ text: string; labels: string[] }>;
  karte: ReturnType<typeof fakeKarte>;
  events: ReturnType<typeof fakeEvents>;
}> {
  const karte = fakeKarte(opts.linked ?? false);
  const events = fakeEvents();
  const screens: Array<{ text: string; labels: string[] }> = [];
  const lineUserId = "Utest0001";

  for (const tap of taps) {
    const action = parseSurveyAction(tap);
    assertTrue(action !== null, `解釈できないタップ: ${tap}`);
    const state = events.state();
    const plan = planSurvey(action!, state);

    // 実装と同じ順序: **返す前に器へ入れる**。
    if (plan.karte) {
      const isFirstTap =
        plan.karte.step != null && (state.answers[plan.karte.step] ?? []).length === 0;
      await recordSurveyKarteWith(lineUserId, plan.karte, { isFirstTap }, karte.deps);
    }
    for (const ev of plan.events) events.push(ev.eventName, ev.step, ev.value);
    if (plan.message) {
      screens.push({
        text: plan.message.text,
        labels: plan.message.quickReplies.map((q) => q.action.label),
      });
    }
  }
  return { screens, karte, events };
}

/** その問いの n 番目の選択肢を押すトークン。 */
function tap(step: string, slug: string): string {
  return `roji｜a｜${step}｜${slug}`;
}

async function main() {
  console.log("\n=== roji 最初のアンケート ===\n");

  // -------------------------------------------------------------------------
  console.log("[1] 画面に出る文言が Spec と一致する");
  // -------------------------------------------------------------------------

  await it("案内（2-0）が Spec のまま", () => {
    assertTrue(
      INTRO_TEXT.startsWith("roji（ろじ）をつくっています。\n月にひとつ、お茶と読みものが届くものです。"),
      "案内の書き出しが違う",
    );
    assertTrue(
      INTRO_TEXT.includes("はじめる前に、6つだけ教えてください。指で選ぶだけで終わります。"),
      "「指で選ぶだけで終わります」が無い",
    );
    assertTrue(
      INTRO_TEXT.includes("答えは、あなたに届けるものを選ぶためと、これからのrojiを作るために使います。"),
      "過剰約束の修正（「だけ」を外した版）が反映されていない",
    );
    assertTrue(INTRO_TEXT.includes("消したいときは、いつでも消せます。"), "「消せます」が無い");
  });

  await it("6つの問いの文と選択肢が Spec のまま", () => {
    assertEqual(
      QUESTIONS.map((q) => q.text),
      [
        "お茶を飲むのは、どんな時間ですか。",
        "お茶のほかに、どんな話なら読みたいですか。",
        "その時間は、どちらに近いですか。",
        "よく飲むお茶は、ありますか。",
        "お茶を選ぶうえで、伝えておきたいことはありますか。",
        "お茶を囲む集まりがあったら、どうしますか。",
      ],
      "問いの文",
    );
    assertEqual(
      QUESTIONS.map((q) => q.choices.map((c) => c.label)),
      [
        ["朝のはじまりに", "昼のあいだに", "夕方から夜に", "夜おそく、ひとりで", "決まっていない"],
        [
          "本や物語のこと",
          "絵や写真のこと",
          "音楽のこと",
          "畑と、つくる人のこと",
          "香りや味の、なぜ",
          "お茶そのもののこと",
          "いまは特に",
        ],
        ["ほどけていたい", "知らないものに出会いたい", "じっくり味わいたい", "どれとも言えない"],
        ["緑茶", "烏龍茶", "紅茶", "決まっていない"],
        ["カフェインが苦手", "妊娠中・授乳中", "アレルギーがある", "特にない"],
        ["現地なら", "オンラインなら", "いまは出ない"],
      ],
      "選択肢の文言",
    );
  });

  await it("〔特にない〕は問い5 の最後に置かれている（先頭に置くと申告を取りこぼす）", () => {
    const q5 = QUESTIONS[4];
    assertEqual(q5.choices[q5.choices.length - 1].label, "特にない", "〔特にない〕の位置");
  });

  await it("引用の許可（2-10）は既定と同じ「rojiの中だけで」が先", async () => {
    const { screens } = await runFlow([
      tap("q1", "late_night"),
      "roji｜next",
      "roji｜next",
      "roji｜next",
      "roji｜next",
      "roji｜next",
      "roji｜next",
    ]);
    assertTrue(screens.length > 0, "画面が出ていない");
    // 引用の許可の画面そのものは planWords 側（言葉を書いた人だけ）。文言だけ確認する。
    assertTrue(
      QUOTE_CONSENT_TEXT.startsWith("いただいた言葉は、rojiの中だけで読みます。"),
      "引用の許可の文言",
    );
  });

  await it("終わりの画面（2-11）に買う導線が無い", () => {
    assertTrue(CLOSING_TEXT.includes("ありがとうございました。"), "終わりの文言");
    assertTrue(!/https?:\/\//.test(CLOSING_TEXT), "終わりの画面に URL が置かれている");
    assertTrue(!/購入|買う|カート|ご注文|お申し込み/.test(CLOSING_TEXT), "終わりの画面に買う導線がある");
  });

  // -------------------------------------------------------------------------
  console.log("\n[2] 条件① 全部1タップ");
  // -------------------------------------------------------------------------

  await it("内部の記号が本人の吹き出しに出ない（全ボタンが postback・表示は選んだ言葉だけ）", () => {
    const screens = [
      buildIntroScreen(),
      ...QUESTIONS.map((q) => buildQuestionScreen(q)),
      buildFinalScreenMessage({ q1: ["morning"] }),
      buildFixScreen({ q3: ["serenity"] }),
      buildWordsScreen("ok"),
      buildQuoteScreen(),
    ];
    for (const s of screens) {
      for (const item of s.quickReplies) {
        assertEqual(item.action.type, "postback", `message ボタンが残っている: ${item.action.label}`);
        assertEqual(item.action.text, undefined, "本人の発話として記号が送られてしまう");
        assertTrue(!!item.action.data, `内部データが無い: ${item.action.label}`);
        // 本人の画面に出るのは、押した言葉そのものだけ。
        assertEqual(item.action.displayText, item.action.label, "吹き出しに出す文字がラベルと違う");
        assertTrue(
          !String(item.action.displayText).includes("｜") &&
            !String(item.action.displayText).includes("roji｜"),
          `吹き出しに内部の記号が出る: ${item.action.displayText}`,
        );
      }
    }
  });

  await it("どの問いの画面にも〔ここで終える〕が常設されている", () => {
    for (const q of QUESTIONS) {
      const screen = buildQuestionScreen(q);
      const labels = screen.quickReplies.map((x) => x.action.label);
      assertTrue(labels.includes(LABEL_END), `${q.step} に〔${LABEL_END}〕が無い`);
    }
  });

  await it("答えたあとの画面にも必ず〔ここで終える〕がある", async () => {
    const { screens } = await runFlow([
      tap("q1", "late_night"),
      "roji｜next",
      tap("q2", "music"),
      "roji｜next",
      tap("q3", "serenity"),
    ]);
    for (const s of screens) {
      assertTrue(s.labels.includes(LABEL_END), `〔${LABEL_END}〕が無い画面: ${s.text}`);
    }
  });

  await it("自由入力を必須にしていない（ひとことは〔このまま終える〕で1タップ通過できる）", () => {
    const plan = planSurvey({ kind: "confirm", choice: "ok" }, buildSurveyState([]));
    const labels = plan.message!.quickReplies.map((q) => q.action.label);
    assertTrue(labels.includes("このまま終える"), "〔このまま終える〕が無い＝1タップで抜けられない");
  });

  await it("選択肢の文言が1タップのボタンに収まる（20文字以内）", () => {
    for (const q of QUESTIONS) {
      for (const c of q.choices) {
        assertTrue(c.label.length <= 20, `長すぎるラベル: ${c.label}`);
      }
    }
  });

  await it("1画面のボタンが LINE の上限（13個）を超えない", () => {
    for (const q of QUESTIONS) {
      assertTrue(
        buildQuestionScreen(q).quickReplies.length <= 13,
        `${q.step} のボタンが多すぎる`,
      );
    }
  });

  // -------------------------------------------------------------------------
  console.log("\n[3] 条件③ 進むほど当たると分かる（伸びる1行）");
  // -------------------------------------------------------------------------

  await it("問い1〜4 で1行が Spec のとおりに伸びる", () => {
    const a: SurveyAnswers = { q1: ["late_night"] };
    assertEqual(buildProgressLine(a, "q1"), "夜おそくの時間、と覚えました。", "2-1 の返し");
    a.q2 = ["music", "farm"];
    assertEqual(buildProgressLine(a, "q2"), "夜おそくの時間に、音楽と、畑の話。", "2-2 の返し");
    a.q3 = ["serenity"];
    assertEqual(
      buildProgressLine(a, "q3"),
      "夜おそくの時間に、音楽と、畑の話。ほどけるための一杯。",
      "2-3 の返し",
    );
    a.q4 = ["green"];
    assertEqual(
      buildProgressLine(a, "q4"),
      "夜おそくの時間に、音楽と、畑の話。ほどけるための、やわらかい緑茶。",
      "2-4 の返し",
    );
  });

  await it("問い5 の返しだけ違う（扱いの約束を返す）", () => {
    assertEqual(
      buildProgressLine({ q5: ["caffeine_sensitive"] }, "q5"),
      "選ぶ前に、必ず見ます。",
      "2-5 の返し",
    );
  });

  await it("最初の1タップで、もう1行が返る（記録されていることが最初に伝わる）", () => {
    assertEqual(buildProgressLine({ q1: ["morning"] }, "q1"), "朝のはじまり、と覚えました。", "1問目の返し");
  });

  // -------------------------------------------------------------------------
  console.log("\n[4] 最後の画面 — Spec の例と完全一致");
  // -------------------------------------------------------------------------

  await it("例1: 6問すべてに答え、カフェインの申告がある人", () => {
    const a: SurveyAnswers = {
      q1: ["late_night"],
      q2: ["music", "farm"],
      q3: ["serenity"],
      q4: ["green"],
      q5: ["caffeine_sensitive"],
      q6: ["online"],
    };
    assertEqual(
      buildFinalScreen(a),
      [
        "いま、rojiが分かっていること。",
        "",
        "カフェインのことは、選ぶ前に必ず見ます。",
        "そのうえで、夜おそくの時間に、音楽と、畑の話。ほどけるための一杯を。",
        "集まりは、オンラインなら。",
        "",
        "合っていますか。",
      ].join("\n"),
      "例1",
    );
  });

  await it("例1 の要: 安全の申告がある人の行に、お茶の名前を出さない", () => {
    const withSafety = buildFinalScreen({
      q1: ["late_night"],
      q3: ["serenity"],
      q4: ["green"],
      q5: ["caffeine_sensitive"],
    });
    assertTrue(!withSafety.includes("緑茶"), "安全の申告があるのにお茶の名前が出ている");
    assertTrue(
      withSafety.indexOf("選ぶ前に必ず見ます") < withSafety.indexOf("そのうえで"),
      "安全の行が最上段に無い",
    );
  });

  await it("例3: 問い1だけ答えて〔ここで終える〕を押した人", () => {
    assertEqual(
      buildFinalScreen({ q1: ["late_night"] }),
      [
        "いま、rojiが分かっていること。",
        "",
        "夜おそくの時間。",
        "",
        "ここから、少しずつです。",
      ].join("\n"),
      "例3",
    );
  });

  await it("例3 の要: 空の状態を欠落として書かない", () => {
    const s = buildFinalScreen({ q1: ["late_night"] });
    assertTrue(!s.includes("まだ"), "「まだ、これだけです」系の欠落の報告になっている");
    assertTrue(s.includes("ここから、少しずつです。"), "「ここから、少しずつです。」が無い");
  });

  await it("例4: 6問すべて「決まっていない」系を選んだ人", () => {
    assertEqual(
      buildFinalScreen({
        q1: ["undecided"],
        q2: ["none_for_now"],
        q3: ["undecided"],
        q4: ["undecided"],
        q5: ["none"],
        q6: ["not_now"],
      }),
      [
        "いま、rojiが分かっていること。",
        "",
        "飲む時間も、読みたい話も、まだ決まっていない。",
        "集まりは、いまは出ない。",
        "",
        "ここから、少しずつです。",
      ].join("\n"),
      "例4",
    );
  });

  await it("答えていない部分は、その部分だけ落ちる（文が壊れない）", () => {
    // 話が無いので、時間は接続の形にしない（「夜おそくの時間に。」と助詞が浮かないこと）。
    const s = buildFinalScreen({ q1: ["late_night"], q4: ["green"] });
    assertTrue(s.includes("夜おそくの時間。"), `時間が落ちている: ${s}`);
    assertTrue(s.includes("やわらかい緑茶。"), "お茶が落ちている");
    assertTrue(!s.includes("、。") && !s.includes("。。"), `文が壊れている: ${s}`);
    assertTrue(!s.includes("に。"), `助詞が浮いている: ${s}`);
    // 話があるときは接続の形になる。
    const withWindows = buildFinalScreen({ q1: ["late_night"], q2: ["music"], q4: ["green"] });
    assertTrue(withWindows.includes("夜おそくの時間に、音楽の話。"), `接続の形にならない: ${withWindows}`);
  });

  // -------------------------------------------------------------------------
  console.log("\n[5] 条件② 途中でやめても成立する — 器に本当に入っているか");
  // -------------------------------------------------------------------------

  await it("シナリオ: 1問だけ答えて離脱 → その1問が本当にカルテに入っている", async () => {
    const { karte, events } = await runFlow([tap("q1", "late_night"), "roji｜end"]);
    const k = karte.read("Utest0001");
    assertTrue(k !== undefined, "カルテが 1 件も作られていない");
    assertEqual(k.tasteProfile?.scenePref, "夜おそく、ひとりで", "項目11（飲む場面・時間帯）");
    // 生の答えも残っている（項目31）。
    const answers = events.rows.filter((r) => r.event_name === "survey.answer");
    assertEqual(answers.map((r) => [r.step, r.value]), [["q1", "late_night"]], "項目31 の生の答え");
  });

  await it("まとめて保存していない: 1問答えた時点で、もうカルテに入っている", async () => {
    const { karte } = await runFlow([tap("q1", "morning")]);
    assertEqual(karte.read("Utest0001").tasteProfile?.scenePref, "朝のはじまりに", "1問目で即書き込み");
  });

  await it("シナリオ: 6問完走 → 9つの項目すべてが器に入っている", async () => {
    const { karte } = await runFlow([
      tap("q1", "late_night"),
      "roji｜next",
      tap("q2", "music"),
      tap("q2", "farm"),
      "roji｜next",
      tap("q3", "serenity"),
      "roji｜next",
      tap("q4", "green"),
      "roji｜next",
      tap("q5", "caffeine_sensitive"),
      "roji｜next",
      tap("q6", "online"),
      "roji｜next",
      "roji｜ok",
      "roji｜skip",
    ]);
    const k = karte.read("Utest0001");
    assertEqual(k.tasteProfile?.scenePref, "夜おそく、ひとりで", "項目11");
    assertEqual(k.windowAffinity?.music, 1, "項目12（音楽）");
    assertEqual(k.windowAffinity?.farm, 1, "項目12（農）");
    assertEqual(k.persona?.scores.serenity, SURVEY_PERSONA_WEIGHT, "項目7（やすらぎ）");
    assertEqual(k.persona?.primary, "serenity", "項目7（primary）");
    assertEqual(k.tasteProfile?.preferredCategories, ["green"], "項目9");
    assertEqual(k.safety?.tags, ["caffeine_sensitive"], "項目6");
    assertEqual(k.eventInterest, "online", "項目14");
    // 項目19 は「1行の推定」だけ。安全の行（項目6）・集まりの行（項目14）は含めない。
    assertEqual(
      k.estimateLine,
      "夜おそくの時間に、音楽と、畑の話。ほどけるための一杯。",
      "項目19（1行の推定）",
    );
  });

  await it("項目19 には『1行の推定』だけが入る（画面の全文を入れない）", async () => {
    const { karte } = await runFlow([
      tap("q1", "late_night"),
      "roji｜next",
      tap("q2", "music"),
      tap("q2", "farm"),
      "roji｜next",
      tap("q3", "serenity"),
      "roji｜next",
      tap("q4", "green"),
      "roji｜next",
      tap("q5", "caffeine_sensitive"),
      "roji｜next",
      tap("q6", "online"),
      "roji｜next",
      "roji｜ok",
    ]);
    const line = karte.read("Utest0001").estimateLine as string;
    // 1行であること（改行を含まない）。
    assertEqual(line.includes("\n"), false, `項目19 が複数行になっている: ${JSON.stringify(line)}`);
    // 画面の飾り（見出し・問いかけ・接続）が混ざっていないこと。
    for (const junk of ["いま、rojiが分かっていること。", "合っていますか。", "そのうえで、"]) {
      assertTrue(!line.includes(junk), `項目19 に画面の文が混ざっている: ${junk}`);
    }
    // 安全の行・集まりの行は別の項目が正本なので、この行に持たせない。
    assertTrue(!line.includes("選ぶ前に必ず見ます"), "項目19 に安全の行（項目6）が混ざっている");
    assertTrue(!line.includes("集まりは"), "項目19 に集まりの行（項目14）が混ざっている");
    // ただし「安全の申告があるならお茶の名前を出さない」規則はこの行にも効く。
    assertTrue(!line.includes("緑茶"), "項目19 に安全の申告があるのにお茶の名前が出ている");
    assertEqual(line, "夜おそくの時間に、音楽と、畑の話。ほどけるための一杯。", "項目19 の1行");
  });

  await it("項目19: 安全の申告が無い人は、お茶の名前まで入った1行になる", () => {
    assertEqual(
      buildEstimateLine({
        q1: ["late_night"],
        q2: ["music", "farm"],
        q3: ["serenity"],
        q4: ["green"],
        q5: ["none"],
        q6: ["online"],
      }),
      "夜おそくの時間に、音楽と、畑の話。ほどけるための、やわらかい緑茶。",
      "項目19 の1行",
    );
  });

  await it("項目19: 推定と呼べるものが無いときは書かない（空で上書きしない）", async () => {
    assertEqual(buildEstimateLine({ q5: ["caffeine_sensitive"] }), "", "安全だけなら推定は空");
    const { karte } = await runFlow([tap("q5", "caffeine_sensitive"), "roji｜next", "roji｜ok"]);
    assertEqual(karte.read("Utest0001").estimateLine, undefined, "空の推定を書き込んでいる");
  });

  await it("項目20: 〔まだ、決めていない〕は常設の選択肢として意思が残る", async () => {
    const { karte } = await runFlow([tap("q1", "morning"), "roji｜next", "roji｜undec"]);
    assertEqual(karte.read("Utest0001").estimateCorrection?.undecided, true, "項目20 の意思");
  });

  await it("項目31: 1行の推定への返事（合っている / 少し違う / まだ決めていない）が記号で残る", async () => {
    const { events } = await runFlow([tap("q1", "morning"), "roji｜next", "roji｜diff"]);
    const confirms = events.rows.filter((r) => r.event_name === "survey.confirm");
    assertEqual(confirms.map((r) => r.value), ["diff"], "〔少し違う〕が項目31 に残る");
  });

  await it("シナリオ: 安全の申告だけをした人 → 項目6 に入り、1行は安全だけになる", async () => {
    const { karte } = await runFlow([tap("q5", "pregnant_or_nursing"), "roji｜end"]);
    const k = karte.read("Utest0001");
    assertEqual(k.safety?.tags, ["pregnant_or_nursing"], "項目6");
    assertEqual(
      buildFinalScreen({ q5: ["pregnant_or_nursing"] }),
      [
        "いま、rojiが分かっていること。",
        "",
        "妊娠中・授乳中のことは、選ぶ前に必ず見ます。",
        "",
        "ここから、少しずつです。",
      ].join("\n"),
      "安全だけの1行",
    );
  });

  await it("シナリオ: 全部「決まっていない」→ 本人の意思として器に入る（未回答と混ざらない）", async () => {
    const { karte, events } = await runFlow([
      tap("q1", "undecided"),
      "roji｜next",
      tap("q2", "none_for_now"),
      "roji｜next",
      tap("q3", "undecided"),
      "roji｜next",
      tap("q4", "undecided"),
      "roji｜next",
      tap("q5", "none"),
      "roji｜next",
      tap("q6", "not_now"),
    ]);
    const k = karte.read("Utest0001");
    assertEqual(k.tasteProfile?.scenePref, "決まっていない", "項目11 に意思が入る");
    assertEqual(k.safety?.tags, ["none"], "項目6 に〔特にない〕が意思として入る");
    assertEqual(k.eventInterest, "not_now", "項目14 に〔いまは出ない〕が入る");
    assertTrue(k.windowAffinity?.lastUpdated != null, "項目12 は答えた事実（lastUpdated）が残る");
    // 押した記号は 6 件すべて項目31 に残る。
    assertEqual(
      events.rows.filter((r) => r.event_name === "survey.answer").length,
      6,
      "項目31 に 6 件残る",
    );
  });

  await it("シナリオ: 2回やり直し → やり直しではなく続きから", async () => {
    const events = fakeEvents();
    // 1 回目: q1 まで答えて離脱。
    events.push("survey.start");
    events.push("survey.answer", "q1", "late_night");
    events.push("survey.end");
    // 2 回目: もう一度メニューを押す。
    const plan = planSurvey({ kind: "trigger" }, events.state());
    assertEqual(plan.message!.text, "お茶のほかに、どんな話なら読みたいですか。", "続きの問いから始まる");
    assertTrue(plan.message!.text !== INTRO_TEXT, "案内から始まってしまっている");
  });

  await it("すべて答え終わっている人は、最後の画面だけが出る", () => {
    const events = fakeEvents();
    for (const [step, slug] of [
      ["q1", "late_night"],
      ["q2", "music"],
      ["q3", "serenity"],
      ["q4", "green"],
      ["q5", "none"],
      ["q6", "online"],
    ] as const) {
      events.push("survey.answer", step, slug);
    }
    const plan = planSurvey({ kind: "trigger" }, events.state());
    assertTrue(plan.message!.text.startsWith("いま、rojiが分かっていること。"), "最後の画面が出ていない");
    assertTrue(
      plan.events.some((e) => e.eventName === "survey.estimate_shown"),
      "項目29（表示した）が残っていない",
    );
  });

  await it("1つ目のタップで確定する（押し足しは確定を動かさない）", async () => {
    const { karte } = await runFlow([tap("q1", "late_night"), tap("q1", "morning")]);
    assertEqual(
      karte.read("Utest0001").tasteProfile?.scenePref,
      "夜おそく、ひとりで",
      "1つ目のタップが確定した答えのまま",
    );
  });

  await it("複数選べる問いは押し足せる（窓は両方に傾きが付く）", async () => {
    const { karte } = await runFlow([tap("q2", "music"), tap("q2", "farm")]);
    const w = karte.read("Utest0001").windowAffinity!;
    assertEqual([w.music, w.farm], [1, 1], "項目12 の押し足し");
  });

  // -------------------------------------------------------------------------
  console.log("\n[5b] 連打・再タップに強いこと（何度押しても結果が同じ）");
  // -------------------------------------------------------------------------

  await it("同じ選択肢を5回押しても、窓の傾き（項目12）は1のまま", async () => {
    const { karte, events } = await runFlow([
      tap("q2", "music"),
      tap("q2", "music"),
      tap("q2", "music"),
      tap("q2", "music"),
      tap("q2", "music"),
    ]);
    assertEqual(karte.read("Utest0001").windowAffinity?.music, 1, "押した回数が傾きになっている");
    // 押した事実そのものは、生の出来事として毎回残る（消さない）。
    assertEqual(
      events.rows.filter((r) => r.event_name === "survey.answer").length,
      5,
      "項目31 に押した回数が残っていない",
    );
  });

  await it("同じ気持ちを5回押しても、傾き（項目7）は重み1回分のまま", async () => {
    const { karte } = await runFlow([
      tap("q3", "serenity"),
      tap("q3", "serenity"),
      tap("q3", "serenity"),
      tap("q3", "serenity"),
      tap("q3", "serenity"),
    ]);
    assertEqual(
      karte.read("Utest0001").persona?.scores.serenity,
      SURVEY_PERSONA_WEIGHT,
      "連打で傾きが積み上がっている",
    );
  });

  await it("気持ちを押し替えたら、前の分は戻る（両方が積み上がらない）", async () => {
    const { karte } = await runFlow([tap("q3", "serenity"), tap("q3", "explorer")]);
    const s = karte.read("Utest0001").persona!.scores;
    assertEqual(
      [s.serenity, s.explorer],
      [0, SURVEY_PERSONA_WEIGHT],
      "押し替えたのに前の傾きが残っている",
    );
    assertEqual(karte.read("Utest0001").persona?.primary, "explorer", "primary が押し替え後になる");
  });

  await it("同じ安全の申告・同じカテゴリを何度押しても増えない", async () => {
    const { karte } = await runFlow([
      tap("q5", "allergy"),
      tap("q5", "allergy"),
      tap("q4", "green"),
      tap("q4", "green"),
    ]);
    const k = karte.read("Utest0001");
    assertEqual(k.safety?.tags, ["allergy"], "項目6 が重複している");
    assertEqual(k.tasteProfile?.preferredCategories, ["green"], "項目9 の照合語彙が重複している");
    assertEqual(k.teaCategoryPreference?.values, ["green"], "項目9 の本人の答えが重複している");
  });

  await it("集まり・場面を押し替えても、値は1つに保たれる", async () => {
    const { karte } = await runFlow([
      tap("q6", "onsite"),
      tap("q6", "online"),
      tap("q1", "morning"),
      tap("q1", "morning"),
    ]);
    const k = karte.read("Utest0001");
    assertEqual(k.eventInterest, "online", "項目14 は押し替え後の1つ");
    assertEqual(k.drinkingScenes?.values, ["morning"], "項目11 が重複している");
  });

  // -------------------------------------------------------------------------
  console.log("\n[5c] 広げた器（項目11 の複数値 / 項目9 の「決まっていない」）");
  // -------------------------------------------------------------------------

  await it("項目11: 複数の場面を、押した順に全部持てる", async () => {
    const { karte } = await runFlow([
      tap("q1", "late_night"),
      tap("q1", "morning"),
      tap("q1", "evening"),
    ]);
    const k = karte.read("Utest0001");
    assertEqual(k.drinkingScenes?.values, ["late_night", "morning", "evening"], "項目11 の複数値");
    // 代表値（既存の読み手が使う単一値）は、1つ目に確定した答えのまま。
    assertEqual(k.tasteProfile?.scenePref, "夜おそく、ひとりで", "代表値が動いている");
  });

  await it("項目11・項目9: 「決まっていない」と「まだ聞いていない」が別の値になる", async () => {
    const { karte } = await runFlow([tap("q1", "undecided"), tap("q4", "undecided")]);
    const k = karte.read("Utest0001");
    assertEqual(k.drinkingScenes?.undecided, true, "項目11 の「決まっていない」が値として残らない");
    assertEqual(k.teaCategoryPreference?.undecided, true, "項目9 の「決まっていない」が値として残らない");
    // 照合語彙は汚さない（どのお茶にも当たらない値を 1 つも入れない）。
    assertEqual(k.tasteProfile?.preferredCategories ?? [], [], "照合語彙に「決まっていない」が混ざった");
    // まだ聞いていない人は、そもそも項目が無い（＝空欄）。
    const { karte: untouched } = await runFlow([tap("q5", "none")]);
    assertEqual(untouched.read("Utest0001").drinkingScenes, undefined, "聞いていないのに値がある");
  });

  await it("〔いまはやめておく〕は追いかけない（何も送らない）", () => {
    const plan = planSurvey({ kind: "decline" }, buildSurveyState([]));
    assertEqual(plan.message, null, "何か送ってしまっている");
    assertEqual(plan.karte, null, "カルテに書いてしまっている");
  });

  // -------------------------------------------------------------------------
  console.log("\n[6] 訂正・ひとこと・引用の許可");
  // -------------------------------------------------------------------------

  await it("〔少し違う〕は気持ちの言い換えを1タップで選ばせる（問い3 の残り + どれも違う）", () => {
    const plan = planSurvey({ kind: "confirm", choice: "diff" }, buildSurveyState([
      { event_name: "survey.answer", step: "q3", value: "serenity", created_at: "2026-08-08T00:00:01Z" },
    ]));
    assertEqual(plan.message!.text, "どれが近いですか。", "2-8 の文言");
    assertEqual(
      plan.message!.quickReplies.map((q) => q.action.label),
      ["知らないものに出会いたい", "じっくり味わいたい", "どれも違う"],
      "選ばなかった残り + どれも違う",
    );
  });

  await it("〔少し違う〕の画面に「この一行は表示しない」を置かない（じぶんのページ側の常設設定）", () => {
    const plan = planSurvey({ kind: "confirm", choice: "diff" }, buildSurveyState([]));
    const labels = plan.message!.quickReplies.map((q) => q.action.label);
    assertTrue(!labels.some((l) => l.includes("表示しない")), "「表示しない」が置かれている");
  });

  await it("訂正すると、項目20 に入り、項目7 が上書きされる（二重加算しない）", async () => {
    const { karte } = await runFlow([
      tap("q3", "serenity"),
      "roji｜next",
      "roji｜next",
      "roji｜next",
      "roji｜next",
      "roji｜diff",
      "roji｜fix｜explorer",
    ]);
    const k = karte.read("Utest0001");
    assertEqual(k.estimateCorrection?.choice, "explorer", "項目20");
    assertEqual(k.persona?.scores.explorer, SURVEY_PERSONA_WEIGHT, "項目7 の上書き（新しい軸）");
    assertEqual(k.persona?.primary, "explorer", "primary が訂正後になる");
  });

  await it("〔どれも違う〕は呼びかけの文が変わる（ここがいちばん濃い言葉が出る場所）", () => {
    const plan = planSurvey({ kind: "fix", slug: null }, buildSurveyState([]));
    assertEqual(plan.message!.text, "どのあたりが違いましたか。ひとことで大丈夫です。", "2-9 の呼びかけ");
  });

  await it("呼びかけの文は、直前に押したもので変わる（Spec 2-9 の表）", () => {
    const cases: Array<[() => string, string]> = [
      [() => planSurvey({ kind: "confirm", choice: "ok" }, buildSurveyState([])).message!.text, "もし、付け足したいことがあれば。"],
      [() => planSurvey({ kind: "fix", slug: "explorer" }, buildSurveyState([])).message!.text, "ほかにも違うところがあれば。"],
      [() => planSurvey({ kind: "fix", slug: null }, buildSurveyState([])).message!.text, "どのあたりが違いましたか。ひとことで大丈夫です。"],
      [() => planSurvey({ kind: "confirm", choice: "undecided" }, buildSurveyState([])).message!.text, "もし、書いておきたいことがあれば。"],
    ];
    for (const [fn, expected] of cases) assertEqual(fn(), expected, "呼びかけの文");
  });

  await it("〔書く〕で呼びかけを出し直したときも「出した」が記録される（分母を落とさない）", async () => {
    const { events } = await runFlow([
      tap("q1", "morning"),
      "roji｜next",
      "roji｜ok",
      "roji｜write",
    ]);
    const prompts = events.rows.filter((r) => r.event_name === "survey.words_prompt");
    assertEqual(prompts.length, 2, "出し直したのに『出した』が残っていない");
    assertEqual(prompts.map((r) => r.value), ["ok", "ok"], "呼びかけの文脈（項目39）が残る");
  });

  await it("1つも答えずに終えた人の最後の画面に、空行が2つ続かない", () => {
    const s = buildFinalScreen({});
    assertTrue(!s.includes("\n\n\n"), `空行が2つ続いている: ${JSON.stringify(s)}`);
    assertEqual(
      s,
      ["いま、rojiが分かっていること。", "", "ここから、少しずつです。"].join("\n"),
      "1つも答えていない人の画面",
    );
  });

  await it("言葉を書いた人にだけ、引用の許可を一度だけ聞く", () => {
    const first = planWords({
      answers: {},
      started: true,
      awaitingWords: true,
      awaitingContext: "ok",
      wordsWritten: false,
      quoteAsked: false,
    });
    assertTrue(first.message.text.startsWith("いただいた言葉は、"), "初回は引用の許可を聞く");
    const second = planWords({
      answers: {},
      started: true,
      awaitingWords: true,
      awaitingContext: "ok",
      wordsWritten: true,
      quoteAsked: true,
    });
    assertTrue(second.message.text.startsWith("ありがとうございました。"), "2回目は聞かない");
  });

  await it("引用の既定は「引用しない」（答えないと false のまま）", async () => {
    const { karte } = await runFlow([tap("q1", "morning")]);
    assertEqual(karte.read("Utest0001").quoteConsent, undefined, "既定で許可が立っていない");
    const { karte: k2 } = await runFlow([tap("q1", "morning"), "roji｜q｜in"]);
    assertEqual(k2.read("Utest0001").quoteConsent, false, "〔rojiの中だけで〕= 引用しない");
    const { karte: k3 } = await runFlow([tap("q1", "morning"), "roji｜q｜out"]);
    assertEqual(k3.read("Utest0001").quoteConsent, true, "〔名前を伏せてなら、外でも〕= 許可");
  });

  // -------------------------------------------------------------------------
  console.log("\n[7] 出来事の置き場に自由文を入れない / 禁じ手が無い");
  // -------------------------------------------------------------------------

  await it("出来事の置き場には選択肢の記号しか入らない（自由文は入らない）", async () => {
    const { events } = await runFlow([
      tap("q1", "late_night"),
      "roji｜next",
      "roji｜next",
      "roji｜next",
      "roji｜next",
      "roji｜next",
      "roji｜ok",
    ]);
    for (const r of events.rows) {
      for (const v of [r.step, r.value]) {
        if (v == null) continue;
        assertTrue(/^[A-Za-z0-9_.\-]{1,40}$/.test(v), `記号でない値が入っている: ${v}`);
      }
    }
  });

  await it("言葉の出所はアンケートの自由記述（10種のうちの1つ）", () => {
    assertEqual(SURVEY_WORD_SOURCE, "survey_free_text", "出所9");
  });

  await it("画面のどこにも禁じ手（点数・煽り・比較・買う導線）が無い", async () => {
    const texts: string[] = [INTRO_TEXT, CLOSING_TEXT, QUOTE_CONSENT_TEXT];
    for (const q of QUESTIONS) {
      texts.push(q.text, ...q.choices.map((c) => c.label));
    }
    texts.push(
      buildFinalScreen({ q1: ["late_night"], q2: ["music"], q3: ["serenity"], q4: ["green"], q6: ["online"] }),
    );
    const banned = [
      /[0-9]+点/,
      /満点/,
      /ランキング/,
      /バッジ/,
      /連続/,
      /あと[0-9]+問/,
      /もう少しです/,
      /みなさん/,
      /ぜひ/,
      /お楽しみに/,
      /今だけ/,
      /残りわずか/,
      /お得/,
      /もったいない/,
      /本当によろしいですか/,
      /ご協力/,
      /診断/,
      /！/,
      /[\u{1F300}-\u{1FAFF}]/u,
    ];
    for (const t of texts) {
      for (const re of banned) {
        assertTrue(!re.test(t), `禁じ手が入っている（${re}）: ${t}`);
      }
    }
  });

  await it("画面ごとに問いの数を数えない（進捗の煽りを置かない）", () => {
    for (const q of QUESTIONS) {
      assertTrue(!/[0-9１-６]\s*問|[0-9]\s*\/\s*6/.test(q.text), `問いの文に進捗がある: ${q.text}`);
    }
  });

  // -------------------------------------------------------------------------
  console.log("\n[8] 素通り（既存フローを壊さない）");
  // -------------------------------------------------------------------------

  await it("無関係な発話は横取りしない", () => {
    for (const s of ["こんにちは", "好みに合うお茶を診断してほしいです", "マイカルテ", "12345", ""]) {
      assertEqual(parseSurveyAction(s), null, `横取りしてしまっている: ${s}`);
    }
  });

  await it("トリガーとトークンだけを横取りする", () => {
    assertEqual(parseSurveyAction(SURVEY_TRIGGER)?.kind, "trigger", "トリガー");
    assertEqual(parseSurveyAction("roji｜a｜q1｜late_night")?.kind, "answer", "回答トークン");
    assertEqual(parseSurveyAction("roji｜a｜q1｜nonexistent"), null, "未知の記号は素通り");
    assertEqual(parseSurveyAction("roji｜zzz"), null, "未知のトークンは素通り");
  });

  // -------------------------------------------------------------------------
  console.log("\n[9] 器への差分（純粋関数）");
  // -------------------------------------------------------------------------

  await it("既存の値を壊さない（配列は足す・傾きは加算・消す方向の統合をしない）", () => {
    const existing = {
      safety: { tags: ["allergy" as const] },
      tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: ["rich"], scenePref: "夜" },
      windowAffinity: { music: 2 },
    };
    const s = surveyKarteUpdates({ step: "q5", slug: "caffeine_sensitive" }, existing, { isFirstTap: true });
    assertEqual(s.safety?.tags, ["allergy", "caffeine_sensitive"], "安全の申告は足す");
    const t = surveyKarteUpdates({ step: "q4", slug: "green" }, existing, { isFirstTap: true });
    assertEqual(t.tasteProfile?.preferredCategories, ["oolong", "green"], "カテゴリは足す");
    assertEqual(t.tasteProfile?.flavorPreferences, ["rich"], "他の好みを消していない");
    const w = surveyKarteUpdates({ step: "q2", slug: "music" }, existing, { isFirstTap: true });
    assertEqual(w.windowAffinity?.music, 3, "傾きは加算");
  });

  await it("「決まっていない」は照合語彙を汚さない（項目9 に入れない・項目31 には残る）", () => {
    const s = surveyKarteUpdates({ step: "q4", slug: "undecided" }, {}, { isFirstTap: true });
    assertEqual(s.tasteProfile, undefined, "カテゴリに「決まっていない」が混ざっている");
  });

  await it("「どれとも言えない」は傾きを動かさない", () => {
    const s = surveyKarteUpdates({ step: "q3", slug: "undecided" }, {}, { isFirstTap: true });
    assertEqual(s.persona, undefined, "傾きが動いてしまっている");
  });

  await it("次に出す問いは、答えていない最初の問い", () => {
    assertEqual(nextUnanswered({})?.step, "q1", "何も答えていない");
    assertEqual(nextUnanswered({ q1: ["morning"], q2: ["music"] })?.step, "q3", "続きから");
    assertEqual(
      nextUnanswered({ q1: ["a"], q2: ["a"], q3: ["a"], q4: ["a"], q5: ["a"], q6: ["a"] }),
      null,
      "全部答えたら null",
    );
  });

  await it("組み立ての規則: 集まりの答えは最後の1行として足される", () => {
    const { lines } = composeUnderstanding({ q1: ["morning"], q6: ["onsite"] });
    assertEqual(lines[lines.length - 1], "集まりは、現地なら。", "集まりの行が最後");
  });

  // -------------------------------------------------------------------------
  console.log(`\n=== ${passed}/${total} passed ===`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

void main();
