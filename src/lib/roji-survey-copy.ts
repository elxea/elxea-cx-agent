/**
 * roji 最初のアンケート — **画面に出る文言の正本の写し**（純粋なデータのみ）。
 *
 * 一次入力（仕様の正本・そのまま貼れる文言として確定済み）:
 *   roji 最初のアンケート Spec  https://www.notion.so/3b570c9d064c81e6b0fcf19356e65406  第2章
 * 答えの行き先（項目番号）:
 *   rojiカルテの項目 — 最終形の定義  https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
 *
 * ─ このファイルの役割 ─
 *   Spec 第2章の文言を **1文字も変えずに** 置く。ロジックはここに書かない
 *   （文言とロジックを混ぜると、ロジックの都合で文言が書き換わるため）。
 *
 * ─ Spec に無く、実装のために補った文言（`FILLED` と明記した箇所だけ）─
 *   Spec は「答えたあとに返る1行」を **例でしか示していない**（例: 「夜おそく、ひとりで」→「夜おそくの時間」）。
 *   全選択肢分の断片は Spec に無いため、例が示す作り方に合わせて機械的に補った。
 *   補った箇所は **すべて `FILLED:` コメントを付けてある**（報告の根拠）。
 *   補った断片は Setaka / 書き手の確認対象であり、勝手な確定ではない。
 *
 * ─ 置かないもの（確定原則の禁じ手）─
 *   星・点数・ランキング・バッジ・連続記録・進捗の煽り（「あと3問」）・
 *   他人との比較・買う導線・勧誘の言葉。ここに足してはならない
 *   （tests/unit/roji-survey.test.ts が機械チェックする）。
 */

// ---------------------------------------------------------------------------
// 共通のボタン文言（Spec 第2章。全画面に常設）
// ---------------------------------------------------------------------------

/** 全画面に常設する離脱ボタン（Spec 2-1〜2-6）。 */
export const LABEL_END = "ここで終える";
/** 答えたあとの「次へ」（Spec 2-1）。 */
export const LABEL_NEXT = "次へ";
/** 案内の 2 ボタン（Spec 2-0）。 */
export const LABEL_START = "はじめる";
export const LABEL_DECLINE = "いまはやめておく";
/** 最後の画面の 3 ボタン（Spec 2-7）。 */
export const LABEL_CONFIRM_OK = "合っている";
export const LABEL_CONFIRM_DIFF = "少し違う";
export const LABEL_CONFIRM_UNDECIDED = "まだ、決めていない";
/** 訂正の画面（Spec 2-8）。 */
export const LABEL_FIX_NONE = "どれも違う";
/** ひとことの画面（Spec 2-9）。 */
export const LABEL_WRITE = "書く";
export const LABEL_WRITE_SKIP = "このまま終える";
/** 引用の許可（Spec 2-10）。既定と同じものを先に置く。 */
export const LABEL_QUOTE_INSIDE = "rojiの中だけで";
export const LABEL_QUOTE_OUTSIDE = "名前を伏せてなら、外でも";

// ---------------------------------------------------------------------------
// 2-0. 案内（メニューを押した直後の1画面）
// ---------------------------------------------------------------------------

/** Spec 2-0 の案内文（そのまま）。 */
export const INTRO_TEXT = [
  "roji（ろじ）をつくっています。",
  "月にひとつ、お茶と読みものが届くものです。",
  "",
  "はじめる前に、6つだけ教えてください。指で選ぶだけで終わります。",
  "途中でやめても、そこまでは残ります。最後に、分かったことを1行にして返します。",
  "",
  "答えは、あなたに届けるものを選ぶためと、これからのrojiを作るために使います。まとめて外に出すことはしません。",
  "こちらから期限で消すことはしません。消したいときは、いつでも消せます。",
].join("\n");

/**
 * メニューの枠のラベル（Spec 1章「誰に、どこで出すか」）。
 *
 * **本タスクではメニューを差し替えない。** この文字列は「押されたときに始まる」入口の
 * トリガー発話としてのみ使う（既存 5 枠の文言とは衝突しない）。
 * リッチメニューへの登録は公開作業であり、行っていない（scripts/setup-rich-menu.ts は不変）。
 */
export const SURVEY_TRIGGER = "rojiをつくっています";

// ---------------------------------------------------------------------------
// 2-1〜2-6. 6つの問い
// ---------------------------------------------------------------------------

/** 1 つの選択肢。 */
export interface SurveyChoice {
  /** 記録用の記号（flow_events の value・slug）。自由文は入れない。 */
  slug: string;
  /** 画面に出るボタンの文言（Spec のまま）。 */
  label: string;
  /**
   * 答えたあとに返る1行に使う断片。null = 1行に現れない選択肢（「決まっていない」等）。
   * Spec が例で示したものはそのまま。示していないものは FILLED（補った）。
   */
  fragment: string | null;
  /**
   * 最後の1行に組み込むときの形（後ろに文が続くときの接続込み）。省略時は `fragment` と同じ。
   * Spec 2-1 は返しが「夜おそくの時間、と覚えました。」、1行が「夜おそくの時間に、音楽と、…」と
   * 形が違うため、2 つに分けて持つ。
   */
  lineFragment?: string;
  /** 「決まっていない / いまは特に / どれとも言えない / 特にない」の類か（Spec 例4）。 */
  undecided: boolean;
}

export interface SurveyQuestion {
  /** 段の記号（flow_events の step）。 */
  step: "q1" | "q2" | "q3" | "q4" | "q5" | "q6";
  /** 画面に出る問いの文（Spec のまま）。 */
  text: string;
  /** 複数選べるか（1つ目のタップで確定・2つ目以降は押し足し）。 */
  multi: boolean;
  choices: SurveyChoice[];
}

/** Spec 2-1〜2-6。**文言は変更禁止**。 */
export const QUESTIONS: SurveyQuestion[] = [
  {
    step: "q1",
    text: "お茶を飲むのは、どんな時間ですか。",
    multi: true,
    choices: [
      // FILLED: fragment / lineFragment（Spec は「夜おそく、ひとりで」の1例のみ提示）。
      { slug: "morning", label: "朝のはじまりに", fragment: "朝のはじまり", lineFragment: "朝のはじまりに", undecided: false },
      { slug: "daytime", label: "昼のあいだに", fragment: "昼のあいだ", lineFragment: "昼のあいだに", undecided: false },
      { slug: "evening", label: "夕方から夜に", fragment: "夕方から夜", lineFragment: "夕方から夜に", undecided: false },
      // Spec 2-1 / 2-2 の例そのもの（補いではない）。
      { slug: "late_night", label: "夜おそく、ひとりで", fragment: "夜おそくの時間", lineFragment: "夜おそくの時間に", undecided: false },
      { slug: "undecided", label: "決まっていない", fragment: null, undecided: true },
    ],
  },
  {
    step: "q2",
    text: "お茶のほかに、どんな話なら読みたいですか。",
    multi: true,
    choices: [
      // FILLED: fragment（Spec は「音楽のこと」→「音楽」・「畑と、つくる人のこと」→「畑」の2例のみ）。
      { slug: "literature", label: "本や物語のこと", fragment: "物語", undecided: false }, // FILLED
      { slug: "art", label: "絵や写真のこと", fragment: "絵や写真", undecided: false }, // FILLED
      { slug: "music", label: "音楽のこと", fragment: "音楽", undecided: false }, // Spec 例
      { slug: "farm", label: "畑と、つくる人のこと", fragment: "畑", undecided: false }, // Spec 例
      { slug: "science", label: "香りや味の、なぜ", fragment: "香りや味", undecided: false }, // FILLED
      { slug: "tea", label: "お茶そのもののこと", fragment: "お茶", undecided: false }, // FILLED
      { slug: "none_for_now", label: "いまは特に", fragment: null, undecided: true },
    ],
  },
  {
    step: "q3",
    text: "その時間は、どちらに近いですか。",
    multi: false,
    choices: [
      // Spec 2-3 の例「ほどけるための一杯」/ 例2「知らないものに出会うための」。
      { slug: "serenity", label: "ほどけていたい", fragment: "ほどけるための", undecided: false },
      { slug: "explorer", label: "知らないものに出会いたい", fragment: "知らないものに出会うための", undecided: false },
      { slug: "sensory", label: "じっくり味わいたい", fragment: "じっくり味わうための", undecided: false }, // FILLED
      { slug: "undecided", label: "どれとも言えない", fragment: null, undecided: true },
    ],
  },
  {
    step: "q4",
    text: "よく飲むお茶は、ありますか。",
    multi: true,
    choices: [
      // Spec 2-4 の例「やわらかい緑茶」。烏龍茶・紅茶の言い回しは Spec に無い。
      { slug: "green", label: "緑茶", fragment: "やわらかい緑茶", undecided: false },
      { slug: "oolong", label: "烏龍茶", fragment: "烏龍茶", undecided: false }, // FILLED（形容を足さない）
      { slug: "black", label: "紅茶", fragment: "紅茶", undecided: false }, // FILLED（形容を足さない）
      { slug: "undecided", label: "決まっていない", fragment: null, undecided: true },
    ],
  },
  {
    step: "q5",
    text: "お茶を選ぶうえで、伝えておきたいことはありますか。",
    multi: true,
    choices: [
      // Spec 2-7 例1「カフェインのことは、選ぶ前に必ず見ます。」の「カフェイン」部分。
      { slug: "caffeine_sensitive", label: "カフェインが苦手", fragment: "カフェイン", undecided: false },
      { slug: "pregnant_or_nursing", label: "妊娠中・授乳中", fragment: "妊娠中・授乳中", undecided: false }, // FILLED
      { slug: "allergy", label: "アレルギーがある", fragment: "アレルギー", undecided: false }, // FILLED
      // 〔特にない〕は本人の意思（未回答＝空欄とは別の値）。1行には現れない。
      { slug: "none", label: "特にない", fragment: null, undecided: true },
    ],
  },
  {
    step: "q6",
    text: "お茶を囲む集まりがあったら、どうしますか。",
    multi: false,
    choices: [
      // Spec 2-7 例2「集まりは、現地なら。」/ 例1「集まりは、オンラインなら。」/ 例4「集まりは、いまは出ない。」
      { slug: "onsite", label: "現地なら", fragment: "現地なら", undecided: false },
      { slug: "online", label: "オンラインなら", fragment: "オンラインなら", undecided: false },
      { slug: "not_now", label: "いまは出ない", fragment: "いまは出ない", undecided: true },
    ],
  },
];

/** 答えたあとに返る文（Spec 2-5 / 2-6 は問い固有の返し）。 */
export const REPLY_AFTER_Q5 = "選ぶ前に、必ず見ます。";
export const REPLY_AFTER_Q6 = "覚えました。";
/** Spec 2-1: 1問目の返しのひな型（`{fragment}、と覚えました。`）。 */
export function replyAfterQ1(fragment: string): string {
  return `${fragment}、と覚えました。`;
}

// ---------------------------------------------------------------------------
// 2-7. 最後の画面
// ---------------------------------------------------------------------------

export const FINAL_HEADER = "いま、rojiが分かっていること。";
/** Spec 2-7 例1・例2 の締め。 */
export const FINAL_ASK = "合っていますか。";
/** Spec 2-7 例3・例4 の締め（空の状態を欠落として書かない）。 */
export const FINAL_JUST_BEGUN = "ここから、少しずつです。";
/** Spec 2-7 例1: 安全の申告がある人の1行目（お茶の名前を出さない）。 */
export function safetyLine(fragment: string): string {
  return `${fragment}のことは、選ぶ前に必ず見ます。`;
}
/** Spec 2-7 例1: 安全の申告があるときだけ、続く行の頭に置く。 */
export const AFTER_SAFETY_PREFIX = "そのうえで、";
/** Spec 2-7 例1・例2・例4: 集まりの行。 */
export function gatheringLine(fragment: string): string {
  return `集まりは、${fragment}。`;
}
/** Spec 2-7 例4: 時間も話も「決まっていない」人の1行（特別な言い回し）。 */
export const ALL_UNDECIDED_LINE = "飲む時間も、読みたい話も、まだ決まっていない。";
/** Spec 2-3: 気持ちだけでお茶が無いときの結び。 */
export const CUP_WITHOUT_TEA = "一杯";

// ---------------------------------------------------------------------------
// 2-8. 〔少し違う〕を押した人だけの画面
// ---------------------------------------------------------------------------

export const FIX_TEXT = "どれが近いですか。";
/** 〔どれも違う〕を押した人のひとことの呼びかけ（Spec 2-8 / 2-9）。 */
export const WORDS_PROMPT_FIX_NONE = "どのあたりが違いましたか。ひとことで大丈夫です。";

// ---------------------------------------------------------------------------
// 2-9. ひとこと（任意・全体で1か所だけ）
// ---------------------------------------------------------------------------

/** 直前に押したもの → 呼びかけの文（Spec 2-9 の表そのまま）。 */
export const WORDS_PROMPT: Record<string, string> = {
  ok: "もし、付け足したいことがあれば。",
  fix_chosen: "ほかにも違うところがあれば。",
  fix_none: WORDS_PROMPT_FIX_NONE,
  undecided: "もし、書いておきたいことがあれば。",
};

// ---------------------------------------------------------------------------
// 2-10. 言葉を書いた人にだけ、一度だけ
// ---------------------------------------------------------------------------

export const QUOTE_CONSENT_TEXT = [
  "いただいた言葉は、rojiの中だけで読みます。",
  "名前を伏せてなら外でも構わない、という場合だけ教えてください。",
].join("\n");

// ---------------------------------------------------------------------------
// 2-11. 終わりの画面
// ---------------------------------------------------------------------------

export const CLOSING_TEXT = [
  "ありがとうございました。",
  "ここまでの答えは、そのまま残しています。",
  "",
  "何がどう変わったかは、あとで一度だけお知らせします。",
  "消したいときは、ここで言ってください。消します。",
].join("\n");
