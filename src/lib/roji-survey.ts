/**
 * roji 最初のアンケート — LINE の 6 問の導線（純粋ロジック）。
 *
 * 一次入力（仕様の正本）:
 *   roji 最初のアンケート Spec       https://www.notion.so/3b570c9d064c81e6b0fcf19356e65406
 *   rojiカルテの項目 — 最終形の定義  https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
 * 画面に出る文言は `roji-survey-copy.ts`（Spec 第2章の写し）。本ファイルは文言を作らない。
 *
 * ─ 設計の中核（Spec の3条件）─
 *   ① 全部1タップ        … 自由入力を必須にしない。最後の1か所も〔このまま終える〕で通過できる
 *   ② 途中でやめても成立  … **1問ごとに独立して書き込む**。まとめて保存しない
 *   ③ 進むほど当たると分かる … **答えるたびに「覚えたこと」の1行が返り、伸びていく**
 *
 * ─ 状態をどこに置くか（新しい入れ物を作らない）─
 *   会話状態を持たない。**すでに答えたことは「出来事の置き場」（項目31 = flow_events）から読み直す**。
 *   これは項目31 の定義そのもの（「申込・アンケート・ときどき1問の生の答え ＋ 聞いた契機」）であり、
 *   進捗のための新しいテーブル・新しいカルテ項目を 1 つも作らずに
 *   「すでに答えた問いは飛ばし、答えていない問いから始める」（Spec 3章）を満たす。
 *
 * ─ 送信について（絶対）─
 *   本ファイルは **push / broadcast / multicast を一切呼ばない**。返信（reply）のみ。
 *   リッチメニューにも触れない（公開はしない）。
 */

import {
  QUESTIONS,
  type SurveyQuestion,
  type SurveyChoice,
  INTRO_TEXT,
  SURVEY_TRIGGER,
  LABEL_END,
  LABEL_NEXT,
  LABEL_START,
  LABEL_DECLINE,
  LABEL_CONFIRM_OK,
  LABEL_CONFIRM_DIFF,
  LABEL_CONFIRM_UNDECIDED,
  LABEL_FIX_NONE,
  LABEL_WRITE,
  LABEL_WRITE_SKIP,
  LABEL_QUOTE_INSIDE,
  LABEL_QUOTE_OUTSIDE,
  REPLY_AFTER_Q5,
  REPLY_AFTER_Q6,
  replyAfterQ1,
  FINAL_HEADER,
  FINAL_ASK,
  FINAL_JUST_BEGUN,
  safetyLine,
  AFTER_SAFETY_PREFIX,
  gatheringLine,
  ALL_UNDECIDED_LINE,
  CUP_WITHOUT_TEA,
  FIX_TEXT,
  WORDS_PROMPT,
  QUOTE_CONSENT_TEXT,
  CLOSING_TEXT,
} from "./roji-survey-copy";
import type { QuickReplyItem } from "./line";

export { SURVEY_TRIGGER };

// ---------------------------------------------------------------------------
// 停止スイッチ（機能ゲート・既定 OFF）
// ---------------------------------------------------------------------------

/**
 * アンケートを動かしてよいか（純粋・既定 OFF ＝ fail-closed）。
 *
 * `ROJI_SURVEY_ENABLED === "true"` のときだけ true。未設定・空文字・"1"・"TRUE"・"yes" は
 * すべて false。判定は **文字列の完全一致** で、既存の機能ゲートと同じ規約に揃えている
 * （LEGACY_SEGMENT_BROADCAST_ENABLED / DELIVERY_ALLOW_SELF_APPROVAL_PROD /
 *   DELIVERY・DORMANT・MARCHE_SEND_ENABLED）。
 * 引数を `Env` 全体でなく必要な 1 キーだけの構造型にするのも既存に倣う
 * （delivery-approval.ts の selfApprovalRelaxed と同じ形。純粋・テスト容易）。
 *
 * ─ なぜ fail-closed か ─
 *   「secret を消す・空にする＝止まる」が正しい挙動。設定漏れや値の取り違えで
 *   意図せず公開されたままになる状態を作らない。
 *
 * ─ OFF のとき何が起きるか ─
 *   handleRojiSurvey が入口で false を返し、**アンケートは一切起動しない**。
 *   合言葉（SURVEY_TRIGGER）も `roji｜*` トークンも横取りせず、この機能を入れる前（master）と
 *   完全に同じ経路へ素通りする。器（flow_events / カルテ / roji_words）にも一切書かない。
 *
 * ─ 途中まで答えた人が OFF になったら ─
 *   同じく即時停止する（続きも通さない）。「OFF なら master と同じ挙動」を例外なく満たすため、
 *   進行中だけ通す抜け道は作らない。答えは 1 問ごとに独立して器へ入っているので失われず、
 *   再び ON にすると状態は出来事の置き場から読み直され「答えていない問いから」再開する
 *   （この再開はもともとの設計であり、スイッチのための新しい器は 1 つも作っていない）。
 *
 * ─ 切り替えにデプロイは要らない ─
 *   Cloudflare の secret（`wrangler secret put ROJI_SURVEY_ENABLED`）を書き換えるだけで
 *   次のリクエストから効く。コードの再配布を伴わない。
 */
export function isRojiSurveyEnabled(env: { ROJI_SURVEY_ENABLED?: string }): boolean {
  return env.ROJI_SURVEY_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// トークン（tea-menu / preference-diagnosis と同じ state レス方式）
// ---------------------------------------------------------------------------

/** トークン区切り（ユーザー入力にまず現れない全角縦棒）。 */
const SEP = "｜";
/** トークンのプレフィックス。 */
const P = "roji";

/** 直前に押したもの（項目39「そのとき何が起きていたか」の値）。 */
export type WordsContext = "ok" | "fix_chosen" | "fix_none" | "undecided";

export type SurveyAction =
  | { kind: "trigger" }
  | { kind: "begin" }
  | { kind: "decline" }
  | { kind: "answer"; step: StepId; slug: string }
  | { kind: "next" }
  | { kind: "end" }
  | { kind: "confirm"; choice: "ok" | "diff" | "undecided" }
  | { kind: "fix"; slug: string | null }
  | { kind: "write" }
  | { kind: "skipWords" }
  | { kind: "quote"; allowOutside: boolean };

export type StepId = SurveyQuestion["step"];

const STEP_IDS = QUESTIONS.map((q) => q.step);

function questionOf(step: StepId): SurveyQuestion {
  const q = QUESTIONS.find((x) => x.step === step);
  if (!q) throw new Error(`unknown step: ${step}`);
  return q;
}

/** 選択肢を記号から引く（未知の記号は null＝安全側で無視する）。 */
export function choiceOf(step: StepId, slug: string): SurveyChoice | null {
  return questionOf(step).choices.find((c) => c.slug === slug) ?? null;
}

/**
 * 発話をアンケートのアクションに解釈する（純粋）。
 * アンケートと無関係なら null（＝インターセプトせず既存フローへ素通り）。
 */
export function parseSurveyAction(raw: string): SurveyAction | null {
  const t = raw.trim();
  if (!t) return null;
  if (t === SURVEY_TRIGGER) return { kind: "trigger" };
  if (!t.startsWith(P + SEP)) return null;

  const segs = t.split(SEP).slice(1);
  switch (segs[0]) {
    case "go":
      return { kind: "begin" };
    case "no":
      return { kind: "decline" };
    case "next":
      return { kind: "next" };
    case "end":
      return { kind: "end" };
    case "ok":
      return { kind: "confirm", choice: "ok" };
    case "diff":
      return { kind: "confirm", choice: "diff" };
    case "undec":
      return { kind: "confirm", choice: "undecided" };
    case "write":
      return { kind: "write" };
    case "skip":
      return { kind: "skipWords" };
    case "a": {
      const step = segs[1] as StepId;
      const slug = segs[2];
      if (!STEP_IDS.includes(step) || !slug || !choiceOf(step, slug)) return null;
      return { kind: "answer", step, slug };
    }
    case "fix": {
      const slug = segs[1];
      if (!slug) return null;
      return { kind: "fix", slug: slug === "none" ? null : slug };
    }
    case "q": {
      if (segs[1] === "in") return { kind: "quote", allowOutside: false };
      if (segs[1] === "out") return { kind: "quote", allowOutside: true };
      return null;
    }
    default:
      // アンケートのトークンだが解釈できない → 横取りせず素通り（既存フローを壊さない）。
      return null;
  }
}

function tok(...parts: string[]): string {
  return [P, ...parts].join(SEP);
}

// ---------------------------------------------------------------------------
// これまでの答え（項目31 = 出来事の置き場 から読み直す）
// ---------------------------------------------------------------------------

/** 出来事の置き場から読む 1 行（flow_events の必要列だけ）。 */
export interface SurveyEventRow {
  event_name: string;
  step: string | null;
  value: string | null;
  created_at: string;
}

/** 答えの集合（step → 押した記号の列。押した順・重複なし）。 */
export type SurveyAnswers = Partial<Record<StepId, string[]>>;

export interface SurveyState {
  answers: SurveyAnswers;
  /** 案内を出したことがあるか。 */
  started: boolean;
  /** ひとことの呼びかけを出して、まだ言葉を受け取っていない（＝次の自由文が「ひとこと」）。 */
  awaitingWords: boolean;
  /** そのとき直前に押していたもの（項目39）。 */
  awaitingContext: WordsContext | null;
  /** すでに言葉を書いたことがあるか（引用の許可は初回の1回だけ聞く）。 */
  wordsWritten: boolean;
  /** 引用の許可をすでに聞いたか。 */
  quoteAsked: boolean;
}

/** 「ひとこと待ち」が有効な時間（これを過ぎた自由文は、ひとこととして取らない）。 */
export const AWAIT_WORDS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 出来事の行から、いまの状態を組み立てる（純粋）。
 *
 * - 複数選べる問い: 押した順に足していく（重複は無視）。**1つ目のタップで確定**しているので、
 *   2つ目以降が無くても答えは成立する。
 * - 単一の問い: あとから押したものが今の答え（上書き）。**押した記号は 2 件とも項目31 に残る**ので、
 *   考えが変わったこと自体は失われない。
 */
export function buildSurveyState(rows: SurveyEventRow[], now: number = Date.now()): SurveyState {
  const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const answers: SurveyAnswers = {};
  let started = false;
  let wordsWritten = false;
  let quoteAsked = false;
  let awaitingWords = false;
  let awaitingContext: WordsContext | null = null;
  let promptAt = 0;

  for (const r of sorted) {
    switch (r.event_name) {
      case "survey.start":
        started = true;
        break;
      case "survey.answer": {
        const step = r.step as StepId;
        const slug = r.value;
        if (!STEP_IDS.includes(step) || !slug || !choiceOf(step, slug)) break;
        started = true;
        const q = questionOf(step);
        if (q.multi) {
          const cur = answers[step] ?? [];
          if (!cur.includes(slug)) answers[step] = [...cur, slug];
        } else {
          answers[step] = [slug];
        }
        break;
      }
      case "survey.estimate_corrected": {
        // 項目20 の訂正は **項目7 を上書きする**（Spec 2-8 の行き先）。
        // よって、いま効いている気持ちの答えは訂正後の値になる。
        // これを answers に反映しないと、続きから入った人に訂正前の1行が返り、
        // 2 回目の訂正で「上書き」ではなく二重加算になる。
        if (r.value && choiceOf("q3", r.value)) answers.q3 = [r.value];
        break;
      }
      case "survey.words_prompt":
        awaitingWords = true;
        awaitingContext = (r.value as WordsContext) ?? null;
        promptAt = Date.parse(r.created_at) || 0;
        break;
      case "survey.words_saved":
        awaitingWords = false;
        awaitingContext = null;
        wordsWritten = true;
        break;
      case "survey.quote_consent":
        quoteAsked = true;
        break;
      default:
        break;
    }
  }

  // 呼びかけを出したまま放置された状態を、いつまでも「ひとこと待ち」にしない
  // （関係のない発話をひとこととして取り込まないための時間の縛り）。
  if (awaitingWords && promptAt > 0 && now - promptAt > AWAIT_WORDS_WINDOW_MS) {
    awaitingWords = false;
    awaitingContext = null;
  }

  return { answers, started, awaitingWords, awaitingContext, wordsWritten, quoteAsked };
}

/** まだ答えていない最初の問い（すべて答え終わっていれば null）。 */
export function nextUnanswered(answers: SurveyAnswers): SurveyQuestion | null {
  for (const q of QUESTIONS) {
    if (!(answers[q.step] ?? []).length) return q;
  }
  return null;
}

/** 1つでも答えた問いがあるか（「触れた人」の判定と同じ線）。 */
export function hasAnyAnswer(answers: SurveyAnswers): boolean {
  return QUESTIONS.some((q) => (answers[q.step] ?? []).length > 0);
}

// ---------------------------------------------------------------------------
// 伸びる1行（設計の中核）
// ---------------------------------------------------------------------------

function chosen(answers: SurveyAnswers, step: StepId): SurveyChoice[] {
  return (answers[step] ?? [])
    .map((s) => choiceOf(step, s))
    .filter((c): c is SurveyChoice => c !== null);
}

/** 1行に現れる選択肢だけ（「決まっていない」等を落とす）。 */
function substantive(answers: SurveyAnswers, step: StepId): SurveyChoice[] {
  return chosen(answers, step).filter((c) => c.fragment !== null);
}

/**
 * いまの答えから「rojiが分かっていること」の本体を組み立てる（純粋）。
 *
 * 組み立ての規則（Spec 2-7）:
 *   1. 安全の申告があれば必ずいちばん上に置き、**その行にはお茶の名前を出さない**
 *   2. 時間・話・気持ち・お茶を1行にする。答えていない部分は**その部分だけ落とす**（文を壊さない）
 *   3. 集まりの答えがあれば、最後に1行として足す
 */
export function composeUnderstanding(answers: SurveyAnswers): {
  lines: string[];
  /** 気持ち or お茶が入っているか（＝結びを「合っていますか。」にするか）。 */
  hasSubstance: boolean;
  /**
   * **項目19 に入れる「1行の推定」だけ**（画面の見出し・安全の行・集まりの行・問いかけを含まない）。
   *
   * 項目定義の項目19 は「1行の推定（いまの値）／自由記述（定型の言い回しに限る）／**1行**」。
   * 画面に出す文の全体はここに入れない（推定と画面の飾りが混ざり、項目29 と対応が取れなくなる）。
   * 安全の申告は項目6、集まりは項目14 が正本なので、この行には持たせない。
   * ただし **安全の申告があるときにお茶の名前を出さない**規則は、この行にもそのまま効く。
   * 空文字 = まだ推定と呼べるものが無い（＝項目19 に書かない）。
   */
  estimate: string;
} {
  const lines: string[] = [];

  // 規則1: 安全の申告（申告のぶんだけ、いちばん上に）。
  const safety = substantive(answers, "q5");
  for (const s of safety) lines.push(safetyLine(s.fragment as string));
  const hasSafety = safety.length > 0;

  // 規則2: 時間・話・気持ち・お茶。
  //   複数選べる問いのうち、時間とお茶は **1つ目に確定したもの**を1行に使う
  //   （Spec が1行の例で複数を並べていないため、並べ方を勝手に作らない）。
  //   押した記号はすべて項目31 に残り、カルテにも残る。
  const times = substantive(answers, "q1");
  const windows = substantive(answers, "q2");
  const mood = substantive(answers, "q3")[0] ?? null;
  const tea = substantive(answers, "q4")[0] ?? null;

  const q1Undecided = chosen(answers, "q1").some((c) => c.undecided);
  const q2Undecided = chosen(answers, "q2").some((c) => c.undecided);

  // 1行の本体を組み立てる。
  //   joined = true  : 上の「安全の行」に続けて読む形（画面用。「…一杯を。」と receive する）
  //   joined = false : 単独で読む形（項目19 に入れる 1行。前後に何も無い前提）
  // 2 つを 1 か所から作ることで、画面と項目19 の中身がずれないようにする。
  const buildMain = (joined: boolean): string => {
    if (times.length === 0 && windows.length === 0 && q1Undecided && q2Undecided) {
      // Spec 2-7 例4: 全部「決まっていない」系の人。欠落の報告にしない。
      return ALL_UNDECIDED_LINE;
    }
    let main = "";
    const segs: string[] = [];
    if (times.length > 0) {
      const t = times[0];
      // 同じ文に話が続くときだけ接続の形（「夜おそくの時間に、音楽と、畑の話。」）、
      // 続かないなら素の形（「夜おそくの時間。」）。気持ちとお茶は別の文になるので、
      // ここで接続の形にすると「夜おそくの時間に。」と助詞が浮く。
      const alone = windows.length === 0;
      segs.push(alone ? (t.fragment as string) : (t.lineFragment ?? (t.fragment as string)));
    }
    if (windows.length > 0) {
      segs.push(`${windows.map((w) => w.fragment as string).join("と、")}の話`);
    }
    if (segs.length > 0) main = `${segs.join("、")}。`;

    // 気持ちとお茶。規則1: 安全の申告があるときはお茶の名前を出さない（joined に関わらず不変）。
    let cup = "";
    if (mood && tea && !hasSafety) cup = `${mood.fragment}、${tea.fragment}。`;
    else if (mood) cup = `${mood.fragment}${CUP_WITHOUT_TEA}${joined && hasSafety ? "を" : ""}。`;
    else if (tea && !hasSafety) cup = `${tea.fragment}。`;
    if (cup) main = main ? `${main}${cup}` : cup;
    return main;
  };

  const main = buildMain(true);
  if (main) lines.push(hasSafety ? `${AFTER_SAFETY_PREFIX}${main}` : main);

  // 規則3: 集まり。
  const gathering = substantive(answers, "q6")[0] ?? null;
  if (gathering) lines.push(gatheringLine(gathering.fragment as string));

  return { lines, hasSubstance: Boolean(mood || tea), estimate: buildMain(false) };
}

/**
 * 項目19 に入れる「1行の推定」を作る（純粋）。
 * 画面に出す文の全体ではない（画面は `buildFinalScreen`）。
 */
export function buildEstimateLine(answers: SurveyAnswers): string {
  return composeUnderstanding(answers).estimate;
}

/**
 * 答えたあとに返る「覚えたこと」の1行（Spec 2-1〜2-6）。
 *
 * 問い1〜4 は伸びていく1行、問い5 は扱いの約束、問い6 は「覚えました。」。
 */
export function buildProgressLine(answers: SurveyAnswers, justAnswered: StepId): string {
  if (justAnswered === "q5") return REPLY_AFTER_Q5;
  if (justAnswered === "q6") return REPLY_AFTER_Q6;

  const times = substantive(answers, "q1");
  const windows = substantive(answers, "q2");
  const mood = substantive(answers, "q3")[0] ?? null;
  const tea = substantive(answers, "q4")[0] ?? null;

  // 問い1 だけを答えた直後は Spec 2-1 のひな型（「〜、と覚えました。」）。
  if (justAnswered === "q1" && windows.length === 0 && !mood && !tea) {
    if (times.length === 0) return FINAL_JUST_BEGUN; // 「決まっていない」を押した直後
    return replyAfterQ1(times[0].fragment as string);
  }

  const { lines } = composeUnderstanding({
    q1: answers.q1,
    q2: answers.q2,
    q3: answers.q3,
    q4: answers.q4,
  });
  return lines.length > 0 ? lines.join("\n") : FINAL_JUST_BEGUN;
}

/** 最後の画面の全文（Spec 2-7）。 */
export function buildFinalScreen(answers: SurveyAnswers): string {
  const { lines, hasSubstance } = composeUnderstanding(answers);
  const tail = hasSubstance ? FINAL_ASK : FINAL_JUST_BEGUN;
  // 本体が空のとき（1 つも答えずに終えた人）に空行が 2 つ続かないようにする。
  return lines.length > 0
    ? [FINAL_HEADER, "", lines.join("\n"), "", tail].join("\n")
    : [FINAL_HEADER, "", tail].join("\n");
}

// ---------------------------------------------------------------------------
// 画面（テキスト + 1タップのボタン）
// ---------------------------------------------------------------------------

export interface OutMessage {
  text: string;
  quickReplies: QuickReplyItem[];
}

/**
 * 1タップのボタン（**postback で作る**）。
 *
 * なぜ postback か: message で作ると、押した瞬間に `roji｜a｜q1｜late_night` という
 * **内部の記号が本人の吹き出しにそのまま出る**。roji で最初に触れてもらうものなので、
 * 画面に内部の記号を 1 文字も出さない。`displayText` に選んだ言葉だけを出し、
 * 記号は `data`（画面に出ない）で運ぶ。
 */
function qr(label: string, data: string): QuickReplyItem {
  return { type: "action", action: { type: "postback", label, data, displayText: label } };
}

const endButton = () => qr(LABEL_END, tok("end"));

/** 問いの画面（まだ 1 つも押していないとき）。 */
export function buildQuestionScreen(q: SurveyQuestion, already: string[] = []): OutMessage {
  const remaining = q.choices.filter((c) => !already.includes(c.slug));
  const items = remaining.map((c) => qr(c.label, tok("a", q.step, c.slug)));
  return { text: q.text, quickReplies: [...items, endButton()] };
}

/**
 * 答えたあとの画面（覚えたことの1行 + 続けて選ぶ / 次へ / ここで終える）。
 * 複数選べる問いは、残りの選択肢を押し足せる（Spec 2-1「続けて選ぶ（残りの選択肢）」）。
 */
export function buildAfterAnswerScreen(
  q: SurveyQuestion,
  answers: SurveyAnswers,
): OutMessage {
  const already = answers[q.step] ?? [];
  const items: QuickReplyItem[] = [];
  if (q.multi) {
    for (const c of q.choices) {
      if (already.includes(c.slug) || c.undecided) continue;
      items.push(qr(c.label, tok("a", q.step, c.slug)));
    }
  }
  items.push(qr(LABEL_NEXT, tok("next")));
  items.push(endButton());
  return { text: buildProgressLine(answers, q.step), quickReplies: items };
}

/** 案内の画面（Spec 2-0）。 */
export function buildIntroScreen(): OutMessage {
  return {
    text: INTRO_TEXT,
    quickReplies: [qr(LABEL_START, tok("go")), qr(LABEL_DECLINE, tok("no"))],
  };
}

/** 最後の画面（Spec 2-7）。 */
export function buildFinalScreenMessage(answers: SurveyAnswers): OutMessage {
  return {
    text: buildFinalScreen(answers),
    quickReplies: [
      qr(LABEL_CONFIRM_OK, tok("ok")),
      qr(LABEL_CONFIRM_DIFF, tok("diff")),
      qr(LABEL_CONFIRM_UNDECIDED, tok("undec")),
    ],
  };
}

/**
 * 〔少し違う〕の画面（Spec 2-8）。
 * 推し量っているのは「気持ち」の部分だけなので、問い3 で選ばなかった残りを 1 タップで選ぶ。
 */
export function buildFixScreen(answers: SurveyAnswers): OutMessage {
  const q3 = questionOf("q3");
  const picked = answers.q3 ?? [];
  const items = q3.choices
    .filter((c) => !c.undecided && !picked.includes(c.slug))
    .map((c) => qr(c.label, tok("fix", c.slug)));
  items.push(qr(LABEL_FIX_NONE, tok("fix", "none")));
  return { text: FIX_TEXT, quickReplies: items };
}

/** ひとことの画面（Spec 2-9）。呼びかけの文だけが直前に押したもので変わる。 */
export function buildWordsScreen(context: WordsContext): OutMessage {
  return {
    text: WORDS_PROMPT[context],
    quickReplies: [qr(LABEL_WRITE, tok("write")), qr(LABEL_WRITE_SKIP, tok("skip"))],
  };
}

/** 引用の許可（Spec 2-10）。既定と同じ「rojiの中だけで」を先に置く。 */
export function buildQuoteScreen(): OutMessage {
  return {
    text: QUOTE_CONSENT_TEXT,
    quickReplies: [
      qr(LABEL_QUOTE_INSIDE, tok("q", "in")),
      qr(LABEL_QUOTE_OUTSIDE, tok("q", "out")),
    ],
  };
}

/** 終わりの画面（Spec 2-11）。買う導線を置かない＝ボタンを 1 つも付けない。 */
export function buildClosingScreen(): OutMessage {
  return { text: CLOSING_TEXT, quickReplies: [] };
}

// ---------------------------------------------------------------------------
// プラン（アクション + 状態 → 送るもの + 残すもの）
// ---------------------------------------------------------------------------

/** カルテに書く差分（項目番号つき）。空なら書かない。 */
export interface KarteWrite {
  step?: StepId;
  slug?: string;
  /**
   * 単一選択で押し替えたときの、**前に効いていた記号**。
   * 傾き（項目7）のように加算で持つ項目を「上書き」にするために要る（積み上がりを防ぐ）。
   */
  replaces?: string | null;
  /** 訂正で選び直した気持ち（項目7 の上書き ＋ 項目20）。 */
  fixChoice?: string | null;
  /**
   * 訂正の前に効いていた気持ちの記号。**「上書き」を二重加算にしないために要る**
   * （前の分を戻してから、新しい分を足す）。null = 前が無い（気持ちを答えていなかった）。
   */
  fixUndo?: string | null;
  /** 引用の許可（項目18）。 */
  quoteConsent?: boolean;
  /**
   * 項目19: **1行の推定だけ**。画面に出す文の全体を入れてはならない
   * （項目定義の持ち方は「1行」。画面の見出し・安全の行・問いかけは別の項目が正本）。
   */
  estimateLine?: string;
  /** 項目20 の常設選択肢「まだ、決めていない」を押した。 */
  correctionUndecided?: boolean;
}

/** 出来事の置き場に残すもの（項目31 / 29）。 */
export interface SurveyEventOut {
  eventName: string;
  step?: string;
  value?: string;
}

export interface SurveyPlan {
  /** 送る画面。null = 何も送らない（〔いまはやめておく〕は追いかけない）。 */
  message: OutMessage | null;
  events: SurveyEventOut[];
  karte: KarteWrite | null;
  /** 自由文をひとこととして受け取る状態に入るか。 */
  words: { context: WordsContext } | null;
}

const NO_PLAN: SurveyPlan = { message: null, events: [], karte: null, words: null };

/** すでに答え終わっているなら最後の画面、そうでなければ次の問い。 */
function resume(answers: SurveyAnswers): { message: OutMessage; events: SurveyEventOut[] } {
  const q = nextUnanswered(answers);
  if (q) return { message: buildQuestionScreen(q, answers[q.step] ?? []), events: [] };
  return {
    message: buildFinalScreenMessage(answers),
    // 項目29: 1行の推定を表示した（表示のたび）。
    events: [{ eventName: "survey.estimate_shown" }],
  };
}

/**
 * アクションと状態から、送るもの・残すものを決める（純粋・I/O なし）。
 */
export function planSurvey(action: SurveyAction, state: SurveyState): SurveyPlan {
  const { answers } = state;

  switch (action.kind) {
    case "trigger": {
      // もう一度押した人は「やり直しではなく、続きから」（Spec 3章）。
      if (hasAnyAnswer(answers)) {
        const r = resume(answers);
        return { ...NO_PLAN, message: r.message, events: r.events };
      }
      return { ...NO_PLAN, message: buildIntroScreen(), events: [{ eventName: "survey.start" }] };
    }

    case "begin": {
      const r = resume(answers);
      return { ...NO_PLAN, message: r.message, events: r.events };
    }

    case "decline":
      // 「何も起きない。追いかけない。」— 返信もしない。出来事だけ残す（分母のため）。
      return { ...NO_PLAN, events: [{ eventName: "survey.decline" }] };

    case "answer": {
      const q = questionOf(action.step);
      const cur = answers[action.step] ?? [];
      const nextAnswers: SurveyAnswers = {
        ...answers,
        [action.step]: q.multi
          ? cur.includes(action.slug)
            ? cur
            : [...cur, action.slug]
          : [action.slug],
      };
      // 連打・再タップへの備え（1タップのボタンでは普通に起きる）。
      //   すでに記録済みの記号をもう一度押しても、**カルテの値は動かさない**（何度押しても同じ）。
      //   押した事実そのものは項目31 に毎回残す（生の出来事は消さない）。
      const repeat = cur.includes(action.slug);
      //   単一選択で別の記号に押し替えたときは、前の分を戻してから足す（積み上がりを防ぐ）。
      const replaces = !q.multi && cur.length > 0 && cur[0] !== action.slug ? cur[0] : null;
      return {
        message: buildAfterAnswerScreen(q, nextAnswers),
        // 項目31: 押した記号そのもの ＋ 聞いた契機（＝アンケート）。
        events: [{ eventName: "survey.answer", step: action.step, value: action.slug }],
        // 1問ごとに独立して書き込む（まとめて保存しない）。
        karte: repeat ? null : { step: action.step, slug: action.slug, replaces },
        words: null,
      };
    }

    case "next": {
      const r = resume(answers);
      return { ...NO_PLAN, message: r.message, events: r.events };
    }

    case "end": {
      // やめても手ぶらで帰らない。その時点の1行を返す。
      return {
        ...NO_PLAN,
        message: buildFinalScreenMessage(answers),
        events: [{ eventName: "survey.end" }, { eventName: "survey.estimate_shown" }],
      };
    }

    case "confirm": {
      if (action.choice === "diff") {
        return {
          ...NO_PLAN,
          message: buildFixScreen(answers),
          // 項目31: 押した記号（〔少し違う〕）を残す。訂正の言い換えを選ぶ前に離れた人も、
          // 「合っていなかった」ことだけは残る。
          events: [{ eventName: "survey.confirm", value: "diff" }],
        };
      }
      const context: WordsContext = action.choice === "ok" ? "ok" : "undecided";
      return {
        message: buildWordsScreen(context),
        events: [
          { eventName: "survey.confirm", value: action.choice },
          { eventName: "survey.words_prompt", value: context },
        ],
        karte: {
          // 項目19: **1行の推定だけ**（画面の全文ではない）。
          estimateLine: buildEstimateLine(answers),
          // 項目20: 「まだ、決めていない」は常設の選択肢（項目定義）。押されたら意思として残す。
          ...(action.choice === "undecided" ? { correctionUndecided: true } : {}),
        },
        words: { context },
      };
    }

    case "fix": {
      const context: WordsContext = action.slug ? "fix_chosen" : "fix_none";
      const nextAnswers: SurveyAnswers = action.slug
        ? { ...answers, q3: [action.slug] }
        : answers;
      return {
        message: buildWordsScreen(context),
        events: [
          // 項目29: 訂正した。
          { eventName: "survey.estimate_corrected", value: action.slug ?? "none" },
          { eventName: "survey.words_prompt", value: context },
        ],
        // 項目20（訂正）＋ 項目7（傾きの上書き）＋ 項目19（訂正後の1行）。
        karte: {
          fixChoice: action.slug,
          fixUndo: (answers.q3 ?? [])[0] ?? null,
          // 項目19: 訂正後の **1行の推定だけ**（画面の全文ではない）。
          estimateLine: buildEstimateLine(nextAnswers),
        },
        words: { context },
      };
    }

    case "write": {
      // 入力欄の代わりに、同じ呼びかけの文をもう一度出して待つ（新しい文言を作らない）。
      const context = state.awaitingContext ?? "ok";
      return {
        ...NO_PLAN,
        message: buildWordsScreen(context),
        // 再表示も「出した」として残す。**出したのに書かれなかった**が分母として要るため
        // （出したかどうかを数えられないと、書かれなかったことの意味が読めなくなる）。
        events: [{ eventName: "survey.words_prompt", value: context }],
        words: { context },
      };
    }

    case "skipWords":
      return { ...NO_PLAN, message: buildClosingScreen(), events: [{ eventName: "survey.finished" }] };

    case "quote":
      return {
        ...NO_PLAN,
        message: buildClosingScreen(),
        events: [
          { eventName: "survey.quote_consent", value: action.allowOutside ? "outside" : "inside" },
          { eventName: "survey.finished" },
        ],
        // 項目18: 言葉の引用の許可。既定は「引用しない」。
        karte: { quoteConsent: action.allowOutside },
      };
  }
}

/**
 * 「ひとこと待ち」のときに届いた自由文を、言葉の置き場に入れる計画にする（純粋）。
 *
 * 言葉を書いた人にだけ、引用の許可を **初回の1回だけ** 聞く（Spec 2-10 / 項目定義 判断4）。
 * 2 回目以降は聞かずに終わりの画面へ行く。
 */
export function planWords(state: SurveyState): {
  message: OutMessage;
  events: SurveyEventOut[];
  context: WordsContext;
} {
  const context = state.awaitingContext ?? "ok";
  const askQuote = !state.quoteAsked;
  return {
    message: askQuote ? buildQuoteScreen() : buildClosingScreen(),
    events: askQuote
      ? [{ eventName: "survey.words_saved", value: context }]
      : [{ eventName: "survey.words_saved", value: context }, { eventName: "survey.finished" }],
    context,
  };
}
