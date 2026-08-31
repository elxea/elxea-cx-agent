/**
 * @layer CDP
 *
 * 味の軸の語彙の正本 — 顧客プロファイル 第1段 ② / ③ / ④。
 *
 * 設計正本: elxea顧客プロファイル設計 rev.3.2 §3「味の軸」/ §6 第1段 ②③④ / §7 択一 #3
 *   確定 (2026-09-01 Setaka): **(c) 既存の商品タグでシミュレーションしてから確定** →
 *   その結果として **既存 2 軸 + 渋みの 3 軸**。
 *
 * ─ この module が持つもの ─
 *
 *   (a) 3 軸の語彙（②）— 軸名・極・日本語ラベル。**ここが唯一の正本**。
 *   (b) 出所タグの語彙（③）— 「本人が言った / 見て分かった / 推定した」。
 *   (c) 30 銘柄の渋み採点（④）— 採点は**規則の関数**で、表には規則の入力だけを置く。
 *   (d) 分離度シミュレーション（④）— 2 軸と 3 軸で母集団がどれだけ分かれるかを数える。
 *
 * ─ この module が持たないもの（意図的）─
 *
 *   ・軸の位置の推論（減衰・窓・重み）。設計 §6 では **第3段 ⑯** であり第1段の範囲外。
 *     第1段は「材料を取り始める」段なので、L0 に事実を積み L1 に出所付きで置くところまで。
 *   ・商品マスタ。銘柄の正本は Notion Tea Menu List（`src/lib/tea-menu.ts` が読む）。
 *     ここに置くのは **軸の語彙と採点**だけで、商品の属性を写さない。
 *
 * ─ 既存 2 軸との関係（重要）─
 *
 *   香り(aroma) と 味わい(body) は **すでに実装・運用されている**:
 *     - 分類: `src/lib/next-cup.ts` の classifyAroma / classifyBody（Flavor Profile タグの部分一致）
 *     - Notion 側: Tea Menu List に数値プロパティ
 *       「香り：甘い、熟した / 青い、爽やかな」「味わい：すっきり / しっかり」(1-5) が実在する
 *   本 module は **その 2 軸を作り直さない**。語彙として宣言し直し、3 本目（渋み）を足すだけ。
 */

// ---------------------------------------------------------------------------
// (a) 3 軸の語彙（②）
// ---------------------------------------------------------------------------

/**
 * 味の軸。**並び順は同点時の既定の優先順**でもある（persona 軸と同じ作法）。
 *
 * ⚠ ここに軸を足すことは設計判断である。設計 §3 は「後から足す候補（今は足さない）」として
 *   後味の長さ / 温度帯 / 水色の濃さ を挙げているが、**第1段では足さない**。
 */
export const TASTE_AXES = ["astringency", "body", "aroma"] as const;
export type TasteAxis = (typeof TASTE_AXES)[number];

/** 軸の両極。左が弱い側（1 に近い）・右が強い側（5 に近い）。 */
export const TASTE_AXIS_POLES = {
  astringency: ["soft", "firm"],
  body: ["light", "full"],
  aroma: ["dry", "rich"],
} as const satisfies Record<TasteAxis, readonly [string, string]>;

export type TastePole<A extends TasteAxis = TasteAxis> =
  (typeof TASTE_AXIS_POLES)[A][number];

/**
 * お客さんに見せる言葉（設計 §3「読める言葉の見立て」/ R2 数値・星・点数は出さない）。
 *
 * ⚠ 「良い/悪い」の語を入れないこと（設計 §3・Meilgaard 1982 の第一原則）。
 *   ここに「まろやか」等の評価語ではなく **記述語**しか置かないのはそのため。
 */
export const TASTE_AXIS_LABELS: Record<
  TasteAxis,
  { axis: string; low: string; high: string }
> = {
  astringency: { axis: "渋み", low: "やわらかい", high: "しっかり" },
  body: { axis: "味わい", low: "すっきり", high: "しっかり" },
  aroma: { axis: "香り", low: "青い・爽やか", high: "甘い・熟した" },
};

/** 軸の位置の目盛り。Notion 側の既存 2 軸の数値プロパティ（1-5）と同じ形にそろえる。 */
export const TASTE_SCALE_MIN = 1;
export const TASTE_SCALE_MAX = 5;

export function isTasteAxis(value: unknown): value is TasteAxis {
  return typeof value === "string" && (TASTE_AXES as readonly string[]).includes(value);
}

/** その軸の極として有効な値か。 */
export function isTastePole(axis: string, pole: unknown): boolean {
  if (!isTasteAxis(axis)) return false;
  return (
    typeof pole === "string" &&
    (TASTE_AXIS_POLES[axis] as readonly string[]).includes(pole)
  );
}

/** 1-5 の目盛りに収まる整数か。 */
export function isTasteScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= TASTE_SCALE_MIN &&
    value <= TASTE_SCALE_MAX
  );
}

// ---------------------------------------------------------------------------
// (b) 出所タグの語彙（③）
// ---------------------------------------------------------------------------

/**
 * 「その値はどこから来たか」。設計 §6 第1段 ③「すべての項目に
 * 『本人が言った / 見て分かった / 推定した』の出所タグと取得日時」。
 *
 * ─ なぜ第1段で入れるのか ─
 *   後から足せないため。設計 §6 は「出所タグを最初に入れないと、後で
 *   『どれを本人に直させてよいか』が判定できなくなる」と明記している。
 *
 * ─ 採用順（設計 §4 R3）─
 *   declared > observed > inferred。同じ内容が本人の言葉で言えるなら推定を使わない。
 */
export const PROVENANCE_KINDS = ["declared", "observed", "inferred"] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** 採用順の強さ（大きいほど優先）。設計 §4 R3 と 1 対 1。 */
export const PROVENANCE_RANK: Record<ProvenanceKind, number> = {
  declared: 3,
  observed: 2,
  inferred: 1,
};

export const PROVENANCE_LABELS: Record<ProvenanceKind, string> = {
  declared: "本人が言った",
  observed: "見て分かった",
  inferred: "推定した",
};

export function isProvenanceKind(value: unknown): value is ProvenanceKind {
  return typeof value === "string" && (PROVENANCE_KINDS as readonly string[]).includes(value);
}

/** 出所タグ 1 件（取得日時つき）。`at` は ISO 8601。 */
export interface Provenance {
  kind: ProvenanceKind;
  at: string;
}

/**
 * 2 つの出所のうち採用されるほう（設計 §4 R3）。
 * 同じ強さなら **新しいほう**（減衰の思想と整合）。
 */
export function preferProvenance(a: Provenance, b: Provenance): Provenance {
  const ra = PROVENANCE_RANK[a.kind];
  const rb = PROVENANCE_RANK[b.kind];
  if (ra !== rb) return ra > rb ? a : b;
  return a.at >= b.at ? a : b;
}

// ---------------------------------------------------------------------------
// (c) 30 銘柄の渋み採点（④）
// ---------------------------------------------------------------------------

/**
 * 渋みの採点に使う「規則の入力」。
 *
 * ⚠ **すべて推定である。** Notion Tea Menu List に渋みのプロパティは存在せず
 *   （2026-09-01 実測: 数値プロパティは「香り」「味わい」の 2 本のみ）、
 *   採点は下の `astringencyScore` の規則で **機械的に導いた値**である。
 *   試飲による確定は別タスク（→ 設計 §7 #3 の「確定」はこの表の採用を意味しない）。
 *
 * ─ 入力に何を選んだか、なぜか ─
 *
 *   既存 2 軸（Flavor Profile の フルボディ/ライトボディ・リッチ/ドライ）を
 *   **入力に使っていない**。使うと渋みが既存 2 軸の言い換えになり、3 本目の軸を
 *   足す意味（分離度を上げる）が消えるため。代わりに、既存 2 軸と独立で
 *   かつ茶葉の成分に効く 4 つだけを使う:
 *
 *     preparation … 製法。カテキンの残り方が製法で変わる（被覆・釜炒り・発酵）
 *     cultivar    … 品種。カテキン含量は品種差が大きい
 *     season      … 摘採期。日照量が多い二番茶はカテキンが高い
 *     detailTags  … Flavor Profile - Detailed。葉の状態を指す語だけを拾う
 *
 * ─ preparation の出どころ ─
 *   Notion の「製法・仕立て」multi_select は **販売中 30 件すべてで空**（2026-09-01 実測）。
 *   よって銘柄名（「かぶせ茶」「萎凋釜炒り茶」「浅蒸し煎茶」「和烏龍茶」「和紅茶」等）から
 *   読み取った。**名前からの読み取りであることを明示するために列として持つ**
 *   （名前を実行時に parse すると、改名で黙って壊れる）。
 */
export type Preparation =
  /** 被覆栽培（かぶせ茶）。 */
  | "shaded"
  /** 蒸し製の煎茶（手摘み煎茶 / 上煎茶 / 浅蒸し煎茶 / 萎凋煎茶）。 */
  | "steamed_sencha"
  /** 釜炒り（萎凋釜炒り茶 / 釜炒り茶）。 */
  | "pan_fired"
  /** 半発酵（和烏龍茶）。 */
  | "semi_oxidized"
  /** 完全発酵（和紅茶）。 */
  | "oxidized";

/** 摘採期。Notion「Season」の値を畳んだもの。 */
export type Harvest = "first_flush" | "second_flush" | "unspecified";

/** 渋み採点の 1 行（規則の入力のみ。点数は関数が出す）。 */
export interface AstringencyInput {
  /** Tea Menu の 5 桁番号。 */
  productNo: string;
  name: string;
  category: "緑茶" | "青茶" | "紅茶";
  preparation: Preparation;
  cultivar: string;
  harvest: Harvest;
  /** Notion「Flavor Profile - Detailed」の値。空は空配列。 */
  detailTags: string[];
}

/** 製法ごとの土台の点（1-5 の目盛り上）。 */
const PREPARATION_BASE: Record<Preparation, number> = {
  // 被覆でカテキン生成が抑えられ、テアニンが残る。
  shaded: 2,
  // 蒸し製の煎茶。母集団の基準に置く。
  steamed_sencha: 3,
  // 釜炒りは蒸し製より渋みが立ちにくい。
  pan_fired: 2,
  // 半発酵でカテキンが重合し、単体カテキン由来の収斂が減る。
  semi_oxidized: 2,
  // 完全発酵。カテキンはテアフラビン等へ変わるが、強度そのものは残る。
  oxidized: 3,
};

/** カテキン含量が高いことが知られる品種（加点）。 */
const HIGH_CATECHIN_CULTIVARS = new Set(["べにふうき"]);

/** 葉の青さ・野菜様（渋みが立つ側）。 */
const GREEN_TAGS = ["Green | 青々しい", "Vegetable | 野菜のような"];
/** 甘み・海苔様・火入れ（渋みが丸くなる側）。 */
const MELLOW_TAGS = ["Sweet | 甘い", "Marine | 海のような", "Roast | 香ばしい"];

/**
 * 渋みの点（1-5）を規則で出す。**純粋・決定的**。
 *
 * 点 = clip(製法の土台 + 品種 + 摘採期 + 風味タグ, 1, 5)
 *
 * 加減点は 1 群につき最大 ±1（同じ群のタグを 2 つ持っていても -2 にしない）。
 * 群を跨いだ相殺は起きる（青々しい +1 と 甘い -1 が同時にあれば ±0）。
 */
export function astringencyScore(input: AstringencyInput): number {
  let score = PREPARATION_BASE[input.preparation];

  if (HIGH_CATECHIN_CULTIVARS.has(input.cultivar)) score += 1;
  // 二番茶は日照量が多くカテキンが高い。一番茶・不明は基準のまま。
  if (input.harvest === "second_flush") score += 1;

  const tags = input.detailTags;
  if (GREEN_TAGS.some((t) => tags.includes(t))) score += 1;
  if (MELLOW_TAGS.some((t) => tags.includes(t))) score -= 1;

  return Math.min(TASTE_SCALE_MAX, Math.max(TASTE_SCALE_MIN, score));
}

/**
 * 販売中 30 銘柄（Notion Tea Menu List / Status=販売中 / Category ∈ 緑茶・青茶・紅茶）。
 * 2026-09-01 に Notion から取得した実データ。番号昇順。
 */
export const ASTRINGENCY_INPUTS: readonly AstringencyInput[] = [
  { productNo: "10101", name: "やぶきたの手摘み煎茶", category: "緑茶", preparation: "steamed_sencha", cultivar: "やぶきた", harvest: "unspecified", detailTags: ["Green | 青々しい"] },
  { productNo: "10201", name: "静七一三二の萎凋煎茶", category: "緑茶", preparation: "steamed_sencha", cultivar: "静七一三二（さくらみどり）", harvest: "unspecified", detailTags: ["Flowery | 花のような"] },
  { productNo: "10401", name: "ふくみどりの萎凋釜炒り茶", category: "緑茶", preparation: "pan_fired", cultivar: "ふくみどり", harvest: "unspecified", detailTags: ["Flowery | 花のような"] },
  { productNo: "10501", name: "みなみさやかの萎凋釜炒り茶", category: "緑茶", preparation: "pan_fired", cultivar: "みなみさやか", harvest: "unspecified", detailTags: ["Flowery | 花のような"] },
  { productNo: "10601", name: "香駿の萎凋釜炒り茶", category: "緑茶", preparation: "pan_fired", cultivar: "香駿", harvest: "unspecified", detailTags: ["Flowery | 花のような"] },
  { productNo: "10701", name: "やぶきたのかぶせ茶", category: "緑茶", preparation: "shaded", cultivar: "やぶきた", harvest: "unspecified", detailTags: ["Marine | 海のような"] },
  { productNo: "10801", name: "みらいの上煎茶", category: "緑茶", preparation: "steamed_sencha", cultivar: "みらい", harvest: "unspecified", detailTags: ["Flowery | 花のような"] },
  { productNo: "10901", name: "香駿の浅蒸し煎茶", category: "緑茶", preparation: "steamed_sencha", cultivar: "香駿", harvest: "unspecified", detailTags: [] },
  { productNo: "11301", name: "やぶきたの上煎茶", category: "緑茶", preparation: "steamed_sencha", cultivar: "やぶきた", harvest: "unspecified", detailTags: [] },
  { productNo: "11401", name: "やぶきたの釜炒り茶", category: "緑茶", preparation: "pan_fired", cultivar: "やぶきた", harvest: "unspecified", detailTags: [] },
  { productNo: "11501", name: "うんかいの萎凋釜炒り茶", category: "緑茶", preparation: "pan_fired", cultivar: "うんかい", harvest: "unspecified", detailTags: ["Flowery | 花のような", "Sweet | 甘い", "Vegetable | 野菜のような"] },
  { productNo: "11601", name: "さえみどりの上煎茶", category: "緑茶", preparation: "steamed_sencha", cultivar: "さえみどり", harvest: "unspecified", detailTags: ["Fruity | フルーティー", "Sweet | 甘い"] },
  { productNo: "40101", name: "春摘み香駿の和烏龍茶", category: "青茶", preparation: "semi_oxidized", cultivar: "香駿", harvest: "first_flush", detailTags: ["Fruity | フルーティー", "Spicy | スパイシー"] },
  { productNo: "40201", name: "香駿の和烏龍茶", category: "青茶", preparation: "semi_oxidized", cultivar: "香駿", harvest: "first_flush", detailTags: ["Flowery | 花のような"] },
  { productNo: "40301", name: "みなみさやかの和烏龍茶", category: "青茶", preparation: "semi_oxidized", cultivar: "みなみさやか", harvest: "second_flush", detailTags: ["Flowery | 花のような", "Sweet | 甘い"] },
  { productNo: "40401", name: "みらいの和烏龍茶", category: "青茶", preparation: "semi_oxidized", cultivar: "みらい", harvest: "unspecified", detailTags: ["Flowery | 花のような", "Dry | ドライ"] },
  { productNo: "40501", name: "やぶきたの和烏龍茶", category: "青茶", preparation: "semi_oxidized", cultivar: "やぶきた", harvest: "first_flush", detailTags: ["Green | 青々しい", "Flowery | 花のような", "Dry | ドライ"] },
  { productNo: "40601", name: "さやまかおりの和烏龍茶", category: "青茶", preparation: "semi_oxidized", cultivar: "さやまかおり", harvest: "first_flush", detailTags: ["Fruity | フルーティー", "Sweet | 甘い"] },
  { productNo: "50101", name: "夏摘みべにふうきの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "べにふうき", harvest: "second_flush", detailTags: ["Fruity | フルーティー"] },
  { productNo: "50201", name: "春摘みいずみの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "いずみ", harvest: "first_flush", detailTags: ["Fruity | フルーティー"] },
  { productNo: "50301", name: "夏摘み香駿の和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "香駿", harvest: "second_flush", detailTags: ["Sweet | 甘い"] },
  { productNo: "50401", name: "春摘みべにふうきの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "べにふうき", harvest: "first_flush", detailTags: ["Fruity | フルーティー", "Sweet | 甘い"] },
  { productNo: "50501", name: "夏摘みべにふうきの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "べにふうき", harvest: "second_flush", detailTags: [] },
  { productNo: "50601", name: "春摘み香駿の和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "香駿", harvest: "first_flush", detailTags: ["Fruity | フルーティー"] },
  { productNo: "50901", name: "夏摘みさやまかおりの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "さやまかおり", harvest: "second_flush", detailTags: ["Fruity | フルーティー"] },
  { productNo: "51001", name: "春摘みべにふうきの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "べにふうき", harvest: "first_flush", detailTags: ["Fruity | フルーティー", "Sweet | 甘い"] },
  { productNo: "51201", name: "春摘みさやまかおりの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "さやまかおり", harvest: "first_flush", detailTags: ["Spicy | スパイシー", "Sweet | 甘い"] },
  { productNo: "51301", name: "春摘みやぶきたの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "やぶきた", harvest: "first_flush", detailTags: ["Roast | 香ばしい", "Sweet | 甘い"] },
  { productNo: "51501", name: "春摘みいずみの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "いずみ", harvest: "first_flush", detailTags: [] },
  { productNo: "51601", name: "春摘みふくみどりの和紅茶", category: "紅茶", preparation: "oxidized", cultivar: "ふくみどり", harvest: "first_flush", detailTags: ["Fruity | フルーティー", "Sweet | 甘い"] },
];

/** 採点済みの 1 行。`basis` は必ず "inferred"（試飲による確定ではないため）。 */
export interface AstringencyScored extends AstringencyInput {
  score: number;
  pole: TastePole<"astringency">;
  basis: ProvenanceKind;
}

/** 点を 2 極に畳む（3 は「しっかり寄り」に倒さず、中央として firm 側に入れない）。 */
export function astringencyPole(score: number): TastePole<"astringency"> {
  return score >= 4 ? "firm" : "soft";
}

/** 点を 3 段に畳む（分離度シミュレーションで既存 2 軸（2 極）と比べるための粒度）。 */
export type AstringencyBand = "soft" | "mid" | "firm";
export function astringencyBand(score: number): AstringencyBand {
  if (score <= 2) return "soft";
  if (score === 3) return "mid";
  return "firm";
}

/** 30 銘柄を規則で採点した表（④ の成果物）。 */
export function scoreAllAstringency(): AstringencyScored[] {
  return ASTRINGENCY_INPUTS.map((input) => {
    const score = astringencyScore(input);
    return { ...input, score, pole: astringencyPole(score), basis: "inferred" as const };
  });
}

// ---------------------------------------------------------------------------
// (d) 分離度シミュレーション（④）
// ---------------------------------------------------------------------------

/**
 * 既存 2 軸の極（`src/lib/next-cup.ts` の classifyAroma / classifyBody と同じ語彙）。
 * シミュレーションのために、Notion「Flavor Profile」の実タグをそのまま持つ。
 */
export interface ExistingAxes {
  productNo: string;
  aroma: "rich" | "dry";
  body: "full" | "light";
}

/**
 * 販売中 30 銘柄の既存 2 軸（2026-09-01 Notion 実測）。
 * `next-cup.ts` の分類規則（タグの部分一致）を実タグに当てた結果と同じ値。
 */
export const EXISTING_AXES: readonly ExistingAxes[] = [
  { productNo: "10101", aroma: "dry", body: "light" },
  { productNo: "10201", aroma: "rich", body: "full" },
  { productNo: "10401", aroma: "rich", body: "light" },
  { productNo: "10501", aroma: "rich", body: "light" },
  { productNo: "10601", aroma: "rich", body: "light" },
  { productNo: "10701", aroma: "dry", body: "full" },
  { productNo: "10801", aroma: "rich", body: "full" },
  { productNo: "10901", aroma: "rich", body: "light" },
  { productNo: "11301", aroma: "dry", body: "light" },
  { productNo: "11401", aroma: "rich", body: "light" },
  { productNo: "11501", aroma: "rich", body: "full" },
  { productNo: "11601", aroma: "rich", body: "full" },
  { productNo: "40101", aroma: "rich", body: "light" },
  { productNo: "40201", aroma: "dry", body: "light" },
  { productNo: "40301", aroma: "dry", body: "light" },
  { productNo: "40401", aroma: "rich", body: "full" },
  { productNo: "40501", aroma: "dry", body: "light" },
  { productNo: "40601", aroma: "rich", body: "light" },
  { productNo: "50101", aroma: "rich", body: "full" },
  { productNo: "50201", aroma: "rich", body: "full" },
  { productNo: "50301", aroma: "rich", body: "light" },
  { productNo: "50401", aroma: "rich", body: "full" },
  { productNo: "50501", aroma: "rich", body: "full" },
  { productNo: "50601", aroma: "rich", body: "full" },
  { productNo: "50901", aroma: "rich", body: "light" },
  { productNo: "51001", aroma: "rich", body: "full" },
  { productNo: "51201", aroma: "dry", body: "light" },
  { productNo: "51301", aroma: "rich", body: "light" },
  { productNo: "51501", aroma: "dry", body: "light" },
  { productNo: "51601", aroma: "rich", body: "light" },
];

/** 分離度の測り方（セルの数・最大セル・空きセル）。 */
export interface SeparationResult {
  /** 母集団の件数。 */
  population: number;
  /** 組み合わせ上あり得るセルの数。 */
  cellsPossible: number;
  /** 実際に 1 件以上入ったセルの数。 */
  cellsOccupied: number;
  /** いちばん混んでいるセルの件数（小さいほど分かれている）。 */
  largestCell: number;
  /** セルごとの件数（キー昇順）。 */
  cells: Record<string, number>;
}

function tally(keys: string[], cellsPossible: number): SeparationResult {
  const cells: Record<string, number> = {};
  for (const k of keys) cells[k] = (cells[k] ?? 0) + 1;
  const counts = Object.values(cells);
  return {
    population: keys.length,
    cellsPossible,
    cellsOccupied: counts.length,
    largestCell: counts.length === 0 ? 0 : Math.max(...counts),
    cells: Object.fromEntries(Object.entries(cells).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * 既存 2 軸だけで母集団がどれだけ分かれるか（④ の「いま」）。
 * 2 極 × 2 極 = 4 セル。
 */
export function separationByTwoAxes(): SeparationResult {
  return tally(
    EXISTING_AXES.map((t) => `${t.aroma}/${t.body}`),
    4,
  );
}

/**
 * 渋みを足した 3 軸で母集団がどれだけ分かれるか（④ の「これから」）。
 * 2 極 × 2 極 × 3 段 = 12 セル。
 *
 * ⚠ 渋みだけ 3 段なのは、渋みが 1-5 の目盛りを持ち、既存 2 軸がタグ由来の 2 極しか
 *   持たないため。**2 極に落とすと渋みの情報を捨てすぎる**（点 3 の 11 件が
 *   すべて soft 側に倒れ、実質 2 極 × 2 極 × 2 極になる）。
 */
export function separationByThreeAxes(): SeparationResult {
  const scored = new Map(scoreAllAstringency().map((t) => [t.productNo, t]));
  return tally(
    EXISTING_AXES.map((t) => {
      const s = scored.get(t.productNo);
      if (!s) throw new Error(`taste-axes: 渋み採点に無い銘柄 ${t.productNo}`);
      return `${t.aroma}/${t.body}/${astringencyBand(s.score)}`;
    }),
    12,
  );
}

/**
 * 渋みが既存の味わい(body)軸の言い換えになっていないか（直交性の確認）。
 *
 * 言い換えになっていれば、body の片方の極に渋みの 1 段だけが集まる。
 * 両極とも 3 段すべてを持っていれば、渋みは body から独立した情報を持っている。
 */
export function astringencyVsBody(): Record<"full" | "light", Record<AstringencyBand, number>> {
  const scored = new Map(scoreAllAstringency().map((t) => [t.productNo, t]));
  const out = {
    full: { soft: 0, mid: 0, firm: 0 },
    light: { soft: 0, mid: 0, firm: 0 },
  };
  for (const t of EXISTING_AXES) {
    const s = scored.get(t.productNo);
    if (!s) throw new Error(`taste-axes: 渋み採点に無い銘柄 ${t.productNo}`);
    out[t.body][astringencyBand(s.score)] += 1;
  }
  return out;
}
