/**
 * roji 最初のアンケート — LINE の配線（読む → 決める → 返す → 器に入れる）。
 *
 * @layer CX — CX 所有・CDP へ書かせる。ここは LINE 上の対話進行（次に何を聞くか・何を返すか）を
 *   受け持つ。答えの保存そのものは CDP（roji-survey-record）に委ね、ここは呼ぶだけ。
 *   「返す前に器に入れる」という順序は体験の担保なので CX 側の判断として持つ。
 *
 * 一次入力: roji 最初のアンケート Spec  https://www.notion.so/3b570c9d064c81e6b0fcf19356e65406
 *
 * ─ 順序（Spec ②「途中でやめても成立する」の担保）─
 *   **返す前に、答えを器に入れる。** 返信に失敗しても答えは残る（好み診断の
 *   runDiagnosisSideEffects と同じ姿勢。ただしこちらは 1 問ごとに書くので、より強い）。
 *
 * ─ 送信について（絶対）─
 *   使うのは `responder`（reply 優先・push フォールバック）だけ。**こちらから話しかけない。**
 *   push / broadcast / multicast を直接呼ばない。リッチメニューにも触れない。
 *
 * ─ 公開していない ─
 *   入口はトリガー発話（SURVEY_TRIGGER）のみ。**リッチメニューの差し替えは行っていない**ので、
 *   この導線は「動く状態」だが、お客さんの画面には現れない。
 *
 * ─ 停止スイッチ（ROJI_SURVEY_ENABLED・既定 OFF）─
 *   `handleRojiSurvey` の入口が唯一の関門。OFF（未設定含む）なら合言葉もトークンも横取りせず、
 *   この機能を入れる前と同じ経路へ素通りする。判定の正本は roji-survey.ts の isRojiSurveyEnabled。
 *   切り戻しに巻き戻し（rollback）もデプロイも要らない（secret の値を変えるだけで即時反映）。
 */

import type { Env } from "../index";
import type { LineResponder } from "./line";
import { createSupabaseClient } from "./supabase";
import { logFlowEvent, FLOW_EVENTS_TABLE, type FlowEventName } from "./flow-events";
import {
  parseSurveyAction,
  planSurvey,
  planWords,
  buildSurveyState,
  isRojiSurveyEnabled,
  type SurveyEventRow,
  type SurveyPlan,
  type SurveyState,
} from "./roji-survey";
import {
  recordSurveyKarteWith,
  recordSurveyWord,
  SURVEY_OCCASION,
  type SurveyKarteDeps,
} from "./roji-survey-record";
import { throughGateway } from "./cdp/events-gateway";
import {
  tryGetFirestoreEnv,
  getCustomerProfile,
  updateCustomerProfile,
  getLineUserProfile,
  updateLineUserProfile,
} from "./firestore";
import { resolveCallerShopifyCustomerId } from "./shopify";

/** 状態を読み直す範囲（アンケートは 1 回きりなので短くてよい）。 */
const STATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** ひとことの上限（LINE の 1 通の上限より十分に短く、原文はそのまま残す）。 */
export const WORDS_MAX_LENGTH = 2000;

/**
 * この人のアンケートの出来事を読み直す（項目31 = 出来事の置き場）。
 * 失敗は「まだ何も答えていない」に倒す（読めないことで先へ進めなくならないようにする）。
 */
export async function loadSurveyState(
  env: Env,
  lineUserId: string,
  now: number = Date.now(),
): Promise<SurveyState> {
  try {
    const supabase = createSupabaseClient(env);
    const since = new Date(now - STATE_WINDOW_MS).toISOString();
    const { data, error } = await supabase
      .from(FLOW_EVENTS_TABLE)
      .select("event_name, step, value, created_at")
      .eq("user_ref", lineUserId)
      .like("event_name", "survey.%")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) {
      console.warn("[roji-survey] state read failed (treated as empty):", error.message);
      return buildSurveyState([], now);
    }
    return buildSurveyState((data ?? []) as SurveyEventRow[], now);
  } catch (err) {
    console.warn(
      "[roji-survey] state read unexpected error (treated as empty):",
      err instanceof Error ? err.message : err,
    );
    return buildSurveyState([], now);
  }
}

function karteDeps(env: Env): SurveyKarteDeps | null {
  // T-12: Firebase 未設定 → カルテは書けない（出来事の記録は続ける）。
  // 黙って null を返さず、理由を 1 行出してから返す。
  const fsEnv = tryGetFirestoreEnv(env, "roji-survey-handler.karteDeps");
  if (!fsEnv) return null;
  const supabase = createSupabaseClient(env);
  return {
    resolveShopifyId: (id) => resolveCallerShopifyCustomerId(id, "line", supabase),
    getShopifyProfile: (id) => getCustomerProfile(id, fsEnv),
    updateShopifyProfile: (id, updates) => updateCustomerProfile(id, updates, fsEnv),
    getLineProfile: (id) => getLineUserProfile(id, fsEnv),
    updateLineProfile: (id, updates) => updateLineUserProfile(id, updates, fsEnv),
  };
}

/**
 * プランを実行する（**器に入れてから返す**）。
 * カルテの書き込みが落ちても出来事は残す。出来事が落ちても返信はする。
 */
async function applyPlan(
  env: Env,
  lineUserId: string,
  plan: SurveyPlan,
  state: SurveyState,
  responder: LineResponder,
): Promise<void> {
  const supabase = createSupabaseClient(env);

  // 1. カルテ（1問ごとに独立して・その場で）。
  if (plan.karte) {
    const deps = karteDeps(env);
    if (deps) {
      const isFirstTap =
        plan.karte.step != null && (state.answers[plan.karte.step] ?? []).length === 0;
      try {
        // CDP 統合 Stage 1: カルテへの書き込みを透過で通しつつ、答えという出来事を
        //   L0 にも積む。**本文は載せない**（自由文の置き場は roji_words であって L0 ではない）。
        //   recordSurveyKarteWith が返す "skipped"（差分が空 / 未連携）は、これまで
        //   呼び出し側で捨てられていた — gateway が理由として残す（T-12）。
        //   gateway を外すときは recordSurveyKarteWith(...) の直呼びに戻す。
        const occurredAt = new Date().toISOString();
        await throughGateway(
          supabase,
          {
            eventType: "survey.answer_recorded",
            channel: "line",
            identifier: { kind: "line_messaging_uid", value: lineUserId },
            dedupe: `${plan.karte.step ?? "-"}@${occurredAt}`,
            source: "cx-agent.roji-survey",
            occurredAt,
            payload: { step: plan.karte.step ?? null, occasion: SURVEY_OCCASION },
          },
          () => recordSurveyKarteWith(lineUserId, plan.karte!, { isFirstTap }, deps),
          (path) =>
            path === "skipped"
              ? { status: "skipped", reason: "no_karte_delta_or_unlinked" }
              : { status: "ok" },
        );
      } catch (err) {
        console.warn(
          "[roji-survey] karte write failed (non-blocking):",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // 2. 出来事の置き場（項目31・29）。聞いた契機は必ず添える。
  for (const ev of plan.events) {
    await logFlowEvent(supabase, {
      eventName: ev.eventName as FlowEventName,
      userRef: lineUserId,
      step: ev.step,
      value: ev.value,
      metadata: { occasion: SURVEY_OCCASION },
    });
  }

  // 3. 返す（〔いまはやめておく〕は何も送らない）。
  if (plan.message) {
    await responder.text(plan.message.text, plan.message.quickReplies);
  }
}

/**
 * アンケートを進める。無関係な発話は false（＝素通り）。
 *
 * ひとことの受け取りだけは「呼びかけを出した直後の自由文」を横取りする。
 * それ以外の自由文は一切横取りしない（既存の AI 会話を壊さない）。
 */
export async function handleRojiSurvey(
  lineUserId: string,
  userMessage: string,
  env: Env,
  responder: LineResponder,
  opts: {
    /**
     * ひとこと（自由文）として受け取ってよい入力か。
     *
     * **postback からは必ず false**。postback の data は「本人が書いた言葉」ではなく
     * ボタンに仕込まれた内部の文字列なので、言葉の置き場に入ってはならない。
     * 将来 roji 以外の機能が postback を使い始めたとき、その内部文字列が
     * ひとこと待ちの人の言葉として保存される事故を、**経路の分離**で防ぐ
     * （「roji のトークンか」を判定するフィルタだと、判定漏れで事故が起きうる）。
     */
    allowWordsCapture?: boolean;
  } = {},
): Promise<boolean> {
  // 停止スイッチ（ROJI_SURVEY_ENABLED・既定 OFF ＝ fail-closed）。
  //   ここが**唯一の関門**。message 経路（routes/line.ts の handleTextMessage）も
  //   postback 経路（同 handleEvent）も必ずこの関数を通るので、入口を 1 か所で塞げる。
  //   OFF のとき false を返す＝完全な素通り: 合言葉も `roji｜*` トークンも横取りせず、
  //   自由文も見ない（状態の読み出しすら行わない）。message は既存の AI 会話へ流れ、
  //   postback は従来どおり黙って捨てられる（postback は roji 導入前もどこでも扱っていなかった）。
  //   ＝ この機能を入れる前（master）と 1 ミリも変わらない挙動に戻る。
  if (!isRojiSurveyEnabled(env)) return false;

  const action = parseSurveyAction(userMessage);

  if (action) {
    const state = await loadSurveyState(env, lineUserId);
    const plan = planSurvey(action, state);
    await applyPlan(env, lineUserId, plan, state, responder);
    return true;
  }

  // アンケートのトークンでもトリガーでもない入力。
  //   自由文として受け取ってよい経路（＝本人が打った発話）でなければ、ここで手を引く。
  if (opts.allowWordsCapture === false) return false;

  // ひとこと待ちのときだけ、言葉として受け取る。
  const body = userMessage.trim();
  if (!body || body.length > WORDS_MAX_LENGTH) return false;

  const state = await loadSurveyState(env, lineUserId);
  if (!state.awaitingWords) return false;

  const supabase = createSupabaseClient(env);
  // 言葉の置き場へ（原文のまま・分類は空・出所はアンケートの自由記述）。
  const saved = await recordSurveyWord(supabase, lineUserId, body, state.awaitingContext ?? "ok");
  if (!saved) {
    // 器に入らなかったのに「残しました」と返さない。素通りさせて既存の経路に委ねる。
    return false;
  }

  const next = planWords(state);
  for (const ev of next.events) {
    await logFlowEvent(supabase, {
      eventName: ev.eventName as FlowEventName,
      userRef: lineUserId,
      value: ev.value,
      metadata: { occasion: SURVEY_OCCASION },
    });
  }
  await responder.text(next.message.text, next.message.quickReplies);
  return true;
}
