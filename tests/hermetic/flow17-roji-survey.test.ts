/**
 * ハーメティック L1 — 動線17: roji 最初のアンケート（6問・全部1タップ・伸びる1行）。
 *
 * 署名付き webhook → Worker インプロセス dispatch → LINE 送信モックで返答本文を捕捉 → 中身を assert。
 * さらに **モック Supabase の行を読み戻して**、答えが出来事の置き場（項目31）に本当に入ったかを見る
 * （「保存処理を呼んだ」ではなく「入っている」を見る）。
 *
 * 仕様の正本: roji 最初のアンケート Spec https://www.notion.so/3b570c9d064c81e6b0fcf19356e65406
 *
 * ハーメティック＝実ネットワーク不使用・実送信ゼロ。**LINE へ 1 通も送らない**（送信はモックが捕捉する）。
 * カルテ（Firestore）は本ハーメティック環境に bindings が無いため書かれない（fail-safe で skip される）。
 * カルテへの往復は tests/unit/roji-survey.test.ts（インメモリの器に入れて読み戻す）と
 * tests/db/roji-survey.db.test.ts（実 Postgres・staging・ROLLBACK）が担保する。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { messageEvent, postbackEvent, synthLineUserId } from "../lib/synthetic";
import { SURVEY_TRIGGER } from "../../src/lib/roji-survey-copy";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

/**
 * 1 タップ / 1 発話を webhook として流す。
 *
 * 内部の記号（`roji｜...`）は **postback** で流す（本番のボタンと同じ経路）。
 * トリガー発話・ひとことの自由文は message で流す。
 */
async function tap(user: string, text: string): Promise<void> {
  const isToken = text.startsWith("roji｜");
  const { status } = await dispatchLineWebhook({
    env,
    channelSecret: String(env.LINE_CHANNEL_SECRET),
    events: [isToken ? postbackEvent(user, text) : messageEvent(user, text)],
  });
  expect(status).toBe(200);
  await settle();
}

/** 直近の返答テキスト。 */
function lastText(): string {
  const t = h.line.texts();
  return t[t.length - 1] ?? "";
}

/** 直近の返答に付いた 1 タップのボタンのラベル。 */
function lastLabels(): string[] {
  const msgs = h.line.allMessages();
  const last = msgs[msgs.length - 1] as
    | { quickReply?: { items?: Array<{ action?: { label?: string } }> } }
    | undefined;
  return (last?.quickReply?.items ?? []).map((i) => String(i.action?.label ?? ""));
}

function surveyEvents(user: string) {
  return h.supabase
    .all("flow_events")
    .filter((r) => r.user_ref === user && String(r.event_name).startsWith("survey."));
}

describe("hermetic L1 — 動線17: roji 最初のアンケート", () => {
  it("メニューの枠を押すと案内が出る（買う導線も煽りも無い）", async () => {
    const user = synthLineUserId("f17a");
    await tap(user, SURVEY_TRIGGER);

    const text = lastText();
    expect(text, "案内が出る").toContain("roji（ろじ）をつくっています。");
    expect(text, "1タップで終わることを伝える").toContain("指で選ぶだけで終わります。");
    expect(text, "消せることを約束する").toContain("消したいときは、いつでも消せます。");
    expect(lastLabels()).toEqual(["はじめる", "いまはやめておく"]);
    // 出来事: 案内を出した（＝アンケートを出したことの分母）。
    expect(surveyEvents(user).map((r) => r.event_name)).toContain("survey.start");
  });

  it("本人の画面に内部の記号が1文字も出ない（実 webhook 経路で確認）", async () => {
    const user = synthLineUserId("f17i");
    await tap(user, SURVEY_TRIGGER);
    await tap(user, "roji｜go");
    await tap(user, "roji｜a｜q1｜late_night");

    // LINE へ実際に送った全メッセージのボタンを調べる。
    const msgs = h.line.allMessages() as Array<{
      quickReply?: { items?: Array<{ action?: Record<string, unknown> }> };
    }>;
    let checked = 0;
    for (const m of msgs) {
      for (const item of m.quickReply?.items ?? []) {
        const a = item.action ?? {};
        expect(a.type, "内部の記号を message で運んでいる（吹き出しに出る）").toBe("postback");
        expect(a.text, "本人の発話として記号が送られてしまう").toBeUndefined();
        expect(String(a.displayText), "吹き出しに内部の記号が出る").not.toContain("roji｜");
        expect(String(a.displayText)).toBe(String(a.label));
        checked++;
      }
    }
    expect(checked, "ボタンが 1 つも検査されていない").toBeGreaterThan(0);
  });

  it("〔いまはやめておく〕は追いかけない（1通も返さない）", async () => {
    const user = synthLineUserId("f17b");
    await tap(user, SURVEY_TRIGGER);
    const before = h.line.texts().length;
    await tap(user, "roji｜no");
    expect(h.line.texts().length, "何か送ってしまっている").toBe(before);
    expect(surveyEvents(user).map((r) => r.event_name)).toContain("survey.decline");
  });

  it("1問だけ答えて離脱しても、その1問は残り、1行が返る", async () => {
    const user = synthLineUserId("f17c");
    await tap(user, SURVEY_TRIGGER);
    await tap(user, "roji｜go");
    expect(lastText(), "問い1 が出る").toBe("お茶を飲むのは、どんな時間ですか。");
    expect(lastLabels(), "〔ここで終える〕が常設されている").toContain("ここで終える");

    await tap(user, "roji｜a｜q1｜late_night");
    expect(lastText(), "答えた直後に覚えたことが返る").toBe("夜おそくの時間、と覚えました。");

    await tap(user, "roji｜end");
    expect(lastText(), "やめても手ぶらで帰らない").toBe(
      ["いま、rojiが分かっていること。", "", "夜おそくの時間。", "", "ここから、少しずつです。"].join("\n"),
    );

    // 項目31: 押した記号と聞いた契機が、出来事の置き場に本当に入っている。
    const answers = surveyEvents(user).filter((r) => r.event_name === "survey.answer");
    expect(answers.length, "生の答えが 1 件残る").toBe(1);
    expect(answers[0].step).toBe("q1");
    expect(answers[0].value).toBe("late_night");
    expect((answers[0].metadata as Record<string, unknown>).occasion, "聞いた契機＝アンケート").toBe(
      "survey",
    );
  });

  it("答えるたびに1行が伸びる（説明文でなく画面の並びで見せる）", async () => {
    const user = synthLineUserId("f17d");
    await tap(user, SURVEY_TRIGGER);
    await tap(user, "roji｜go");
    await tap(user, "roji｜a｜q1｜late_night");
    expect(lastText()).toBe("夜おそくの時間、と覚えました。");
    await tap(user, "roji｜next");
    await tap(user, "roji｜a｜q2｜music");
    await tap(user, "roji｜a｜q2｜farm");
    expect(lastText(), "押し足しで1行が伸びる").toBe("夜おそくの時間に、音楽と、畑の話。");
    await tap(user, "roji｜next");
    await tap(user, "roji｜a｜q3｜serenity");
    expect(lastText()).toBe("夜おそくの時間に、音楽と、畑の話。ほどけるための一杯。");
    await tap(user, "roji｜next");
    await tap(user, "roji｜a｜q4｜green");
    expect(lastText()).toBe("夜おそくの時間に、音楽と、畑の話。ほどけるための、やわらかい緑茶。");
  });

  it("安全の申告は最上段に置かれ、その行にお茶の名前を出さない", async () => {
    const user = synthLineUserId("f17e");
    await tap(user, SURVEY_TRIGGER);
    await tap(user, "roji｜go");
    for (const t of [
      "roji｜a｜q1｜late_night",
      "roji｜next",
      "roji｜a｜q2｜music",
      "roji｜a｜q2｜farm",
      "roji｜next",
      "roji｜a｜q3｜serenity",
      "roji｜next",
      "roji｜a｜q4｜green",
      "roji｜next",
    ]) {
      await tap(user, t);
    }
    await tap(user, "roji｜a｜q5｜caffeine_sensitive");
    expect(lastText(), "安全だけ返しが違う（扱いの約束）").toBe("選ぶ前に、必ず見ます。");
    await tap(user, "roji｜next");
    await tap(user, "roji｜a｜q6｜online");
    expect(lastText()).toBe("覚えました。");
    await tap(user, "roji｜next");

    expect(lastText(), "Spec 2-7 例1 と完全一致").toBe(
      [
        "いま、rojiが分かっていること。",
        "",
        "カフェインのことは、選ぶ前に必ず見ます。",
        "そのうえで、夜おそくの時間に、音楽と、畑の話。ほどけるための一杯を。",
        "集まりは、オンラインなら。",
        "",
        "合っていますか。",
      ].join("\n"),
    );
    expect(lastText(), "安全の申告がある人にお茶の名前を出さない").not.toContain("緑茶");
    expect(lastLabels()).toEqual(["合っている", "少し違う", "まだ、決めていない"]);
    // 項目29: 1行の推定を表示した。
    expect(surveyEvents(user).map((r) => r.event_name)).toContain("survey.estimate_shown");
  });

  it("もう一度押した人は、やり直しではなく続きから", async () => {
    const user = synthLineUserId("f17f");
    await tap(user, SURVEY_TRIGGER);
    await tap(user, "roji｜go");
    await tap(user, "roji｜a｜q1｜morning");
    // ここで離れて、あとでもう一度メニューを押す。
    await tap(user, SURVEY_TRIGGER);
    expect(lastText(), "案内からやり直させない").toBe("お茶のほかに、どんな話なら読みたいですか。");
  });

  it("ひとことは1か所だけ・1タップで通過でき、書いた人にだけ引用の許可を一度だけ聞く", async () => {
    const user = synthLineUserId("f17g");
    // 内部の連番はモック Supabase が採番できない（GENERATED ALWAYS AS IDENTITY を再現しない）ため、
    // 逆引きだけ先に置いておく。**連番を作る経路そのもの**は実 Postgres で確かめている
    // （tests/db/roji-survey.db.test.ts「項目36: 名前を持たず内部の連番だけで紐づく」）。
    h.supabase.seed("roji_word_person_refs", [
      { person_seq: 1, subject_kind: "line", subject_id: user },
    ]);
    await tap(user, SURVEY_TRIGGER);
    await tap(user, "roji｜go");
    await tap(user, "roji｜a｜q1｜morning");
    await tap(user, "roji｜next");
    await tap(user, "roji｜a｜q2｜literature");
    for (let i = 0; i < 5; i++) await tap(user, "roji｜next");

    await tap(user, "roji｜ok");
    expect(lastText(), "呼びかけの文（〔合っている〕の場合）").toBe("もし、付け足したいことがあれば。");
    expect(lastLabels(), "1タップで通過できる").toContain("このまま終える");

    // 自由文を書く（＝言葉の置き場へ）。
    await tap(user, "夜より朝のほうが、しっくりきます。");
    expect(lastText(), "書いた人にだけ引用の許可を聞く").toContain(
      "いただいた言葉は、rojiの中だけで読みます。",
    );
    expect(lastLabels(), "既定と同じものを先に置く").toEqual([
      "rojiの中だけで",
      "名前を伏せてなら、外でも",
    ]);

    await tap(user, "roji｜q｜in");
    expect(lastText(), "終わりの画面").toContain("ありがとうございました。");
    expect(lastText(), "買う導線を置かない").not.toMatch(/https?:\/\//);
    expect(lastLabels(), "終わりは終わりにする（ボタンを置かない）").toEqual([]);

    // 言葉の本文は出来事の置き場に入らない（自由文は言葉の置き場にだけ在る）。
    const ev = surveyEvents(user);
    const serialized = JSON.stringify(ev);
    expect(serialized, "出来事の置き場に自由文が漏れている").not.toContain("しっくり");
    expect(ev.map((r) => r.event_name)).toContain("survey.words_saved");
    // 言葉の置き場に 1 件だけ入っている（原文そのまま・出所はアンケートの自由記述）。
    const words = h.supabase.all("roji_words");
    expect(words.length, "言葉が 1 件").toBe(1);
    expect(words[0].body).toBe("夜より朝のほうが、しっくりきます。");
    expect(words[0].source).toBe("survey_free_text");
    expect(words[0].context_slug, "項目39 直前に押したもの").toBe("ok");
  });

  it("roji 以外のボタン（postback）は、ひとこと待ちでも言葉として保存されない", async () => {
    const user = synthLineUserId("f17j");
    h.supabase.seed("roji_word_person_refs", [
      { person_seq: 1, subject_kind: "line", subject_id: user },
    ]);
    // ひとこと待ちの状態にする。
    await tap(user, SURVEY_TRIGGER);
    await tap(user, "roji｜go");
    await tap(user, "roji｜a｜q1｜morning");
    for (let i = 0; i < 6; i++) await tap(user, "roji｜next");
    await tap(user, "roji｜ok");
    expect(lastText(), "ひとこと待ちになっていない").toBe("もし、付け足したいことがあれば。");

    // ここで **roji 以外の機能のボタン** を押す（将来そういう機能が足された想定）。
    await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [postbackEvent(user, "someOtherFeature|action=subscribe&id=42")],
    });
    await settle();

    // ボタンに仕込まれた内部の文字列が、本人の言葉として残ってはならない。
    expect(h.supabase.all("roji_words").length, "他機能のボタンが言葉として保存された").toBe(0);
    const saved = surveyEvents(user).filter((r) => r.event_name === "survey.words_saved");
    expect(saved.length, "書いていないのに『書いた』が記録された").toBe(0);

    // 本人が実際に打った言葉は、これまでどおり受け取れる。
    await tap(user, "朝のほうが好きです。");
    expect(h.supabase.all("roji_words").length, "本物のひとことが受け取れていない").toBe(1);
    expect(h.supabase.all("roji_words")[0].body).toBe("朝のほうが好きです。");
  });

  it("アンケートと無関係な発話は横取りしない（既存の動線を壊さない）", async () => {
    const user = synthLineUserId("f17h");
    // アンケートに入っていない人の自由文は、ひとことにならない。
    await tap(user, "こんにちは");
    expect(h.supabase.all("roji_words").length, "言葉として取り込んでしまっている").toBe(0);
    expect(surveyEvents(user).length, "アンケートの出来事を作ってしまっている").toBe(0);
  });
});
