/**
 * 合流（未連携カルテ → 本カルテ）の持ち越し規則 — 宣言的な表。
 *
 * 一次入力（仕様の正本）:
 *   - roji同じ人だと分かる仕組み  https://www.notion.so/3b570c9d064c81d68610f9360f50c965
 *       第3章「装置2: 合流の規則を『項目ごとの表』にして、表に無い項目は既定で持ち越す」
 *       第5章「合流の衝突をどう解くか」
 *   - rojiカルテの項目 — 最終形の定義  https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
 *
 * ■ なぜこのファイルが在るのか（穴1 の構造的封鎖）
 *
 * 従来 `mergeLineUserIntoShopify` は persona と tasteProfile の 2 つだけを処理の中に直接書いて
 * 持ち越していた。よって**カルテに項目を足すたびに合流処理も直さないと、足した項目は合流の瞬間に
 * 黙って落ちる**（＝アンケートの答えが消える）。この「直し忘れ」という失敗様式を、規約や記憶では
 * なく構造で殺すために、持ち越し規則を 2 段構えにする。
 *
 *   (1) **既定は持ち越す（fail-open）** — 表に無いキーは `DEFAULT_RULE`（carry-if-empty）で
 *       持ち越す。表への追記を忘れても、データは落ちない。ここが最後の安全網。
 *   (2) **表は型で網羅を強制する（fail-closed）** — `KARTE_MERGE_RULES` は
 *       `{ [K in keyof Required<LineUserProfile>]: MergeRule }` として宣言してあるため、
 *       `LineUserProfile`（= `RojiKarteFields` を交差した型）に項目を足すと**この表に
 *       エントリを足すまで型検査が落ちる**。「足したのに規則を決めていない」を検知する。
 *
 * (1) だけだと規則の質が担保できず、(2) だけだと型の外から入った値（別経路の書き込み・過去データ）
 * が落ちる。両方あって初めて「項目を足すたびに合流処理の修正を忘れる」が構造的に無くなる。
 *
 * ■ 何も捨てない（足あと）
 * 「1つしか持てない属性」で本カルテ側を残した場合、未連携側の値は捨てずに合流の記録
 * （`KarteMergeRecord.superseded` = 第5章「未連携側の値は足あとに『以前こう答えた』として残す」）
 * に積む。**この関数はいかなる経路でも既存の値を削除しない**（追加と、衝突時の記録のみ）。
 *
 * 純粋関数のみ。I/O は一切しない（呼び出し側 firestore.ts が Firestore へ書く）。
 */

import type {
  CustomerProfile,
  LineUserProfile,
  PersonaProfile,
  TasteProfile,
} from "./firestore";

// ---------------------------------------------------------------------------
// 規則の型
// ---------------------------------------------------------------------------

/**
 * 持ち越しの戦略。第5章「種類別のルール」の各行に 1 対 1 で対応する。
 *
 * - `skip`                  持ち越さない（識別子・制御フラグ・タイムスタンプ）。理由の明記を必須にする。
 * - `persona-sum`           好みタイプの点数 = 足す（別軸への累積加算）。呼び出し側の handler に委譲。
 * - `taste-union`           味・香り・カテゴリ = 両方入れる（重なりは1つに）。呼び出し側の handler に委譲。
 * - `numeric-sum`           数えるものは足す（項目12 窓への傾き）。
 * - `list-union`            リストは両方入れる・重複排除（項目13 また入れてほしい / もういらない）。
 * - `safety-union`          安全に関する申告 = 両方入れる。**消す方向の統合を絶対にしない**（項目6）。
 * - `most-restrictive-bool` 本人の設定 = 制限の強い方（項目18 引用の許可）。
 * - `latest-by`             本人の最新の意思 = 新しい方（項目20 1行の推定への訂正）。
 * - `carry-if-empty`        1つしか持てない属性 = 本カルテ優先・空なら未連携側から。**既定**。
 */
export type MergeRule =
  | { strategy: "skip"; reason: string }
  | { strategy: "persona-sum" }
  | { strategy: "taste-union" }
  /** `exclude` はスコアでない付随キー（例: lastUpdated）。足し算の対象から外す。 */
  | { strategy: "numeric-sum"; exclude: readonly string[] }
  /** `lists` は配列を持つキー名。それ以外のキーは carry-if-empty で扱う。 */
  | { strategy: "list-union"; lists: readonly string[] }
  | { strategy: "safety-union" }
  | { strategy: "most-restrictive-bool" }
  | { strategy: "latest-by"; timestampKey: string }
  | { strategy: "carry-if-empty" };

/**
 * **表に無い項目の既定**。第3章「表に無い項目は既定で持ち越す」の実装。
 *
 * carry-if-empty は「本カルテが空なら未連携側を入れる / 埋まっていれば本カルテを残し、
 * 未連携側の値は足あとへ」。**どちらに転んでも値を失わない**ため、素性の分からない未知の項目に
 * 当てる既定として安全（上書きも削除もしない）。
 */
export const DEFAULT_RULE: MergeRule = { strategy: "carry-if-empty" };

// ---------------------------------------------------------------------------
// 規則の表（正本）
// ---------------------------------------------------------------------------

/**
 * 項目ごとの持ち越し規則。**`LineUserProfile` の全キーを網羅する（型で強制）。**
 *
 * `Required<LineUserProfile>` のマップ型にしてあるので、`RojiKarteFields` や `LineUserProfile` に
 * 項目を足すと、ここにエントリを足すまで `tsc --noEmit` が落ちる。
 * 「カルテに項目を足したが合流の規則を決めていない」を型検査で捕まえるための仕掛け。
 */
export const KARTE_MERGE_RULES: {
  readonly [K in keyof Required<LineUserProfile>]: MergeRule;
} = {
  // --- 識別子・制御（カルテの中身ではない） ---
  lineUserId: {
    strategy: "skip",
    reason: "LINE 側の識別子（項目2）。正本は別名表。本カルテに写さない",
  },
  mergedToShopify: {
    strategy: "skip",
    reason: "合流処理の制御フラグ。未連携カルテ側にだけ立てる",
  },
  mergeRecord: {
    strategy: "skip",
    reason: "合流の記録（項目33）。未連携カルテ側に残す足あと。本カルテへは写さない",
  },
  createdAt: { strategy: "skip", reason: "未連携カルテの作成時刻。本カルテの作成時刻を上書きしない" },
  lastActiveAt: { strategy: "skip", reason: "合流時に now で更新するため持ち越さない" },

  // --- 好み（既存の 2 項目） ---
  persona: { strategy: "persona-sum" },
  tasteProfile: { strategy: "taste-union" },

  // --- 入口の答え（項目15）。穴1 で落ちていた本体 ---
  //   onboarding は複合オブジェクト。carry-if-empty は**サブキー単位**で効くため、
  //   本カルテに completedAt だけあり source が空、という状態でも source だけが持ち越される。
  onboarding: { strategy: "carry-if-empty" },

  // --- タスク07 で足したカルテ 7 項目（定義文書 6 / 12 / 13 / 14 / 18 / 19 / 20） ---
  /** 項目6: 安全に関する申告。消す方向の統合を絶対にしない。 */
  safety: { strategy: "safety-union" },
  /** 項目12: 窓への傾き（6つの窓の数値）。数えるものは足す。 */
  windowAffinity: { strategy: "numeric-sum", exclude: ["lastUpdated"] },
  /** 項目13: また入れてほしい / もういらない。両方入れる（重複排除）。 */
  teaRequests: { strategy: "list-union", lists: ["moreOf", "noneOf"] },
  /** 項目14: イベントへの関心。1つしか持てない属性。 */
  eventInterest: { strategy: "carry-if-empty" },
  /** 項目18: 言葉の引用の許可。本人の設定 → 制限の強い方。 */
  quoteConsent: { strategy: "most-restrictive-bool" },
  quoteConsentAskedAt: { strategy: "carry-if-empty" },
  /** 項目19: 1行の推定（いまの値）。本カルテ優先。 */
  estimateLine: { strategy: "carry-if-empty" },
  estimateLineUpdatedAt: { strategy: "carry-if-empty" },
  /** 項目20: 1行の推定への訂正。本人の最新の意思 → 新しい方。 */
  estimateCorrection: { strategy: "latest-by", timestampKey: "correctedAt" },
};

/** 規則を引く。表に無いキーは既定（持ち越す）。 */
export function ruleFor(field: string): MergeRule {
  return (
    (KARTE_MERGE_RULES as Record<string, MergeRule | undefined>)[field] ?? DEFAULT_RULE
  );
}

// ---------------------------------------------------------------------------
// 合流の記録（項目33）
// ---------------------------------------------------------------------------

/**
 * 合流の記録 — 「いつ / どちらの記録から / 何を持ち越したか」（第5章「合流を取り消せるようにするか」）。
 *
 * 取り消し機能は作らない代わりにこれを残す。誤って合流した場合はこの記録を見て手で戻せる。
 * `superseded` は「1つしか持てない属性で本カルテを残したため採らなかった未連携側の値」＝
 * 第5章の「以前こう答えた」。**捨てずにここへ積む**。
 */
export type KarteMergeRecord = {
  /** ISO 8601。 */
  mergedAt: string;
  /** どちらの記録から（未連携カルテのキー）。 */
  fromLineUserId: string;
  /** どこへ（本カルテのキー = EC上の顧客番号）。 */
  toShopifyCustomerId: string;
  /** 何を持ち越したか（本カルテへ書いたフィールド名）。 */
  carried: string[];
  /** 採らなかった未連携側の値（足あと・「以前こう答えた」）。 */
  superseded: Record<string, unknown>;
  /** 規則の表に無く既定で持ち越したフィールド名（表の追記漏れの可視化）。 */
  carriedByDefaultRule: string[];
};

// ---------------------------------------------------------------------------
// 値のユーティリティ（純粋）
// ---------------------------------------------------------------------------

/** プレーンなオブジェクトか（配列・null・Date を除く）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)
  );
}

/**
 * 「空」= 持ち越しで埋めてよい状態。
 * undefined / null / 空文字 / 空配列 / 全キーが空のオブジェクト。
 * **false と 0 は空ではない**（本人が明示した設定・点数を空と誤判定しない）。
 */
export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.values(v).every(isEmptyValue);
  return false;
}

/** 配列の union（順序は base 優先・重複排除）。プリミティブ前提。 */
function unionList(base: unknown, incoming: unknown): unknown[] {
  const a = Array.isArray(base) ? base : [];
  const b = Array.isArray(incoming) ? incoming : [];
  const out: unknown[] = [...a];
  for (const item of b) {
    if (!out.some((x) => x === item)) out.push(item);
  }
  return out;
}

/** 有限数だけを足す（非有限・非数値は 0 扱い）。 */
function sumNumeric(base: unknown, incoming: unknown): number {
  const a = typeof base === "number" && Number.isFinite(base) ? base : 0;
  const b = typeof incoming === "number" && Number.isFinite(incoming) ? incoming : 0;
  return a + b;
}

/** ISO 8601 文字列を比較可能な数値へ（不正・不在は -Infinity）。 */
function timeValue(v: unknown): number {
  if (typeof v !== "string") return Number.NEGATIVE_INFINITY;
  const t = Date.parse(v);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

// ---------------------------------------------------------------------------
// 戦略ごとの適用（純粋）
// ---------------------------------------------------------------------------

/** 1 フィールドの持ち越し結果。`value === undefined` は「本カルテへ書かない」。 */
type FieldOutcome = {
  /** 本カルテへ書く値（undefined なら書かない）。 */
  value?: unknown;
  /** 採らなかった未連携側の値（足あと行き）。 */
  superseded?: unknown;
};

/**
 * carry-if-empty — 本カルテが空なら未連携側を入れる。埋まっていれば本カルテを残す。
 * 双方がオブジェクトのときは**サブキー単位**で同じ判断をする（入口の答え `onboarding.source` が
 * `completedAt` だけ埋まった本カルテに正しく載るのはこの再帰のおかげ）。
 * 値が食い違って本カルテを残した場合、未連携側の値は足あとへ回す（捨てない）。
 */
function applyCarryIfEmpty(lineValue: unknown, customerValue: unknown): FieldOutcome {
  if (isEmptyValue(lineValue)) return {};
  if (isEmptyValue(customerValue)) return { value: lineValue };

  if (isPlainObject(lineValue) && isPlainObject(customerValue)) {
    const merged: Record<string, unknown> = { ...customerValue };
    const supersededSub: Record<string, unknown> = {};
    let changed = false;
    for (const [k, v] of Object.entries(lineValue)) {
      const sub = applyCarryIfEmpty(v, customerValue[k]);
      if (sub.value !== undefined) {
        merged[k] = sub.value;
        changed = true;
      }
      if (sub.superseded !== undefined) supersededSub[k] = sub.superseded;
    }
    return {
      value: changed ? merged : undefined,
      superseded: Object.keys(supersededSub).length > 0 ? supersededSub : undefined,
    };
  }

  // 同値なら何もしない。食い違うなら本カルテを残し、未連携側は足あとへ。
  if (lineValue === customerValue) return {};
  return { superseded: lineValue };
}

/** numeric-sum — 数値サブキーを足す（項目12）。exclude のキーは足さず carry-if-empty 扱い。 */
function applyNumericSum(
  lineValue: unknown,
  customerValue: unknown,
  exclude: readonly string[],
  now: string,
): FieldOutcome {
  if (!isPlainObject(lineValue)) return applyCarryIfEmpty(lineValue, customerValue);
  const base = isPlainObject(customerValue) ? customerValue : {};
  const out: Record<string, unknown> = { ...base };
  let changed = false;
  for (const [k, v] of Object.entries(lineValue)) {
    if (exclude.includes(k)) continue;
    if (typeof v === "number") {
      const sum = sumNumeric(base[k], v);
      if (sum !== base[k]) changed = true;
      out[k] = sum;
    } else {
      const sub = applyCarryIfEmpty(v, base[k]);
      if (sub.value !== undefined) {
        out[k] = sub.value;
        changed = true;
      }
    }
  }
  if (!changed) return {};
  // 更新時刻を持つ形（lastUpdated 等）なら合流時刻で更新する。
  for (const k of exclude) {
    if (k in lineValue || k in base) out[k] = now;
  }
  return { value: out };
}

/** list-union — 指定リストを union（項目13）。他サブキーは carry-if-empty。 */
function applyListUnion(
  lineValue: unknown,
  customerValue: unknown,
  lists: readonly string[],
  now: string,
): FieldOutcome {
  if (!isPlainObject(lineValue)) return applyCarryIfEmpty(lineValue, customerValue);
  const base = isPlainObject(customerValue) ? customerValue : {};
  const out: Record<string, unknown> = { ...base };
  let changed = false;
  for (const [k, v] of Object.entries(lineValue)) {
    if (lists.includes(k)) {
      const merged = unionList(base[k], v);
      const before = Array.isArray(base[k]) ? (base[k] as unknown[]).length : 0;
      if (merged.length !== before) changed = true;
      out[k] = merged;
    } else if (k !== "updatedAt") {
      const sub = applyCarryIfEmpty(v, base[k]);
      if (sub.value !== undefined) {
        out[k] = sub.value;
        changed = true;
      }
    }
  }
  if (!changed) return {};
  if ("updatedAt" in lineValue || "updatedAt" in base) out.updatedAt = now;
  return { value: out };
}

/**
 * safety-union — 項目6。**片方にでも申告があれば必ず残す。消す方向の統合を絶対にしない。**
 *
 * `tags` は union。`none`（特にない）は他の申告と併存させない方向で**消さない**
 * ——「特にない」を消すのではなく、実申告があるときは `none` を落とさず両方残す方が安全側に思えるが、
 * 割当の判定で「none があるから安全」と誤読される危険がある。よって**実申告が 1 つでもあれば
 * `none` は落とす**（＝より厳しい側に倒す）。これは申告を消しているのではなく、
 * 「特にない」という**申告の不在を意味する印**を、申告が在る事実に合わせて外している。
 * 落とした事実は合流の記録（superseded）に残す。
 * `freeText` は本カルテ優先・空なら未連携側（食い違えば足あとへ）。
 */
function applySafetyUnion(
  lineValue: unknown,
  customerValue: unknown,
  now: string,
): FieldOutcome {
  if (!isPlainObject(lineValue)) return applyCarryIfEmpty(lineValue, customerValue);
  const base = isPlainObject(customerValue) ? customerValue : {};

  const mergedTags = unionList(base.tags, lineValue.tags) as string[];
  const realTags = mergedTags.filter((t) => t !== "none");
  const finalTags = realTags.length > 0 ? realTags : mergedTags;
  const droppedNone = finalTags.length !== mergedTags.length;

  const freeTextOutcome = applyCarryIfEmpty(lineValue.freeText, base.freeText);

  const beforeTags = Array.isArray(base.tags) ? (base.tags as unknown[]) : [];
  const tagsChanged =
    finalTags.length !== beforeTags.length ||
    finalTags.some((t, i) => t !== beforeTags[i]);

  if (!tagsChanged && freeTextOutcome.value === undefined) {
    return { superseded: freeTextOutcome.superseded };
  }

  const out: Record<string, unknown> = { ...base, tags: finalTags, updatedAt: now };
  if (freeTextOutcome.value !== undefined) out.freeText = freeTextOutcome.value;

  const superseded: Record<string, unknown> = {};
  if (freeTextOutcome.superseded !== undefined) {
    superseded.freeText = freeTextOutcome.superseded;
  }
  if (droppedNone) superseded.droppedNoneTag = true;

  return {
    value: out,
    superseded: Object.keys(superseded).length > 0 ? superseded : undefined,
  };
}

/**
 * most-restrictive-bool — 本人の設定は制限の強い方（項目18 引用の許可・既定は「引用しない」）。
 *
 * 明示された `false` がどちらかに在れば `false`（止めている人を合流のついでに再開させない）。
 * 明示が片側だけの `true` は、本人が言った同意なので採る（未設定は「まだ聞いていない」であって
 * 「拒否」ではない）。どちらも未設定なら書かない。
 */
function applyMostRestrictiveBool(
  lineValue: unknown,
  customerValue: unknown,
): FieldOutcome {
  const l = typeof lineValue === "boolean" ? lineValue : undefined;
  const c = typeof customerValue === "boolean" ? customerValue : undefined;
  if (l === undefined) return {};
  if (l === false && c !== false) return { value: false, superseded: c };
  if (c === undefined) return { value: l };
  if (c === false) return l === false ? {} : { superseded: l };
  // c === true
  return l === true ? {} : { value: false, superseded: true };
}

/** latest-by — 新しい方（項目20）。timestampKey で比較し、古い方は足あとへ。 */
function applyLatestBy(
  lineValue: unknown,
  customerValue: unknown,
  timestampKey: string,
): FieldOutcome {
  if (isEmptyValue(lineValue)) return {};
  if (isEmptyValue(customerValue)) return { value: lineValue };
  const lt = isPlainObject(lineValue) ? timeValue(lineValue[timestampKey]) : Number.NEGATIVE_INFINITY;
  const ct = isPlainObject(customerValue)
    ? timeValue(customerValue[timestampKey])
    : Number.NEGATIVE_INFINITY;
  if (lt > ct) return { value: lineValue, superseded: customerValue };
  return { superseded: lineValue };
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/** persona / taste の畳み込みは firestore.ts 側の既存ロジックへ委譲する（SoT を分裂させない）。 */
export type SpecialFolders = {
  /** persona を「別軸への累積加算」で畳む。持ち越すものが無ければ undefined。 */
  foldPersona: (
    linePersona: PersonaProfile | undefined,
    customerPersona: PersonaProfile | undefined,
  ) => PersonaProfile | undefined;
  /** tasteProfile を union で畳む。持ち越すものが無ければ undefined。 */
  foldTaste: (
    lineTaste: TasteProfile | undefined,
    customer: CustomerProfile | null,
  ) => TasteProfile | undefined;
};

export type CarryoverResult = {
  /** 本カルテへ PATCH する差分（既存を消す指示は一切含まない）。 */
  updates: Partial<CustomerProfile>;
  /** 合流の記録（項目33）。 */
  record: KarteMergeRecord;
};

/**
 * 未連携カルテの**実在する全キー**を規則の表に照らして本カルテへの差分に畳む。
 *
 * 走査対象は「型に書いてあるキー」ではなく `Object.keys(lineProfile)` ＝**実際に入っている
 * キー**。よって型に無い（＝別経路で書かれた・将来足された）項目も既定規則で持ち越される。
 * ここが「項目を足すたびに合流処理の修正を忘れる」を殺している一点。
 *
 * @param lineProfile 未連携カルテ（lineUsers/{lineUserId}）
 * @param customerProfile 本カルテ（users/{shopifyCustomerId}）。不在なら null
 * @param ctx 合流の記録に載せる文脈
 * @param folders persona / taste の畳み込み（firestore.ts が注入）
 */
export function computeKarteCarryover(
  lineProfile: LineUserProfile,
  customerProfile: CustomerProfile | null,
  ctx: { lineUserId: string; shopifyCustomerId: string; now: string },
  folders: SpecialFolders,
): CarryoverResult {
  const updates: Record<string, unknown> = {};
  const superseded: Record<string, unknown> = {};
  const carried: string[] = [];
  const carriedByDefaultRule: string[] = [];

  const customer = (customerProfile ?? {}) as Record<string, unknown>;
  const line = lineProfile as Record<string, unknown>;

  for (const field of Object.keys(line)) {
    const rule = ruleFor(field);
    if (rule.strategy === "skip") continue;

    const lineValue = line[field];
    const customerValue = customer[field];
    let outcome: FieldOutcome;

    switch (rule.strategy) {
      case "persona-sum": {
        const folded = folders.foldPersona(
          lineProfile.persona,
          customerProfile?.persona,
        );
        outcome = folded ? { value: folded } : {};
        break;
      }
      case "taste-union": {
        const folded = folders.foldTaste(lineProfile.tasteProfile, customerProfile);
        outcome = folded ? { value: folded } : {};
        break;
      }
      case "numeric-sum":
        outcome = applyNumericSum(lineValue, customerValue, rule.exclude, ctx.now);
        break;
      case "list-union":
        outcome = applyListUnion(lineValue, customerValue, rule.lists, ctx.now);
        break;
      case "safety-union":
        outcome = applySafetyUnion(lineValue, customerValue, ctx.now);
        break;
      case "most-restrictive-bool":
        outcome = applyMostRestrictiveBool(lineValue, customerValue);
        break;
      case "latest-by":
        outcome = applyLatestBy(lineValue, customerValue, rule.timestampKey);
        break;
      case "carry-if-empty":
        outcome = applyCarryIfEmpty(lineValue, customerValue);
        break;
    }

    if (outcome.value !== undefined) {
      updates[field] = outcome.value;
      carried.push(field);
      if (!(field in KARTE_MERGE_RULES)) carriedByDefaultRule.push(field);
    }
    if (outcome.superseded !== undefined) superseded[field] = outcome.superseded;
  }

  return {
    updates: updates as Partial<CustomerProfile>,
    record: {
      mergedAt: ctx.now,
      fromLineUserId: ctx.lineUserId,
      toShopifyCustomerId: ctx.shopifyCustomerId,
      carried: carried.sort(),
      superseded,
      carriedByDefaultRule: carriedByDefaultRule.sort(),
    },
  };
}
