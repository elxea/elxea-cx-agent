/**
 * 販売中お茶メニューの決定的フィクスチャ + Notion クエリのモック。
 *
 * tea-menu.ts の fetchSellingTeas は Notion Tea Menu DB を fetch する（notionQuerySellingTeas）。
 * ここでは api.notion.com/v1/databases/<id>/query の応答を、mapPage が読む実プロパティ名で組み立てて返す。
 *
 * 軸タグ実値（next-cup.ts / tests/unit/next-cup.test.ts と一致・2026-07-17 Notion スキーマ確認済み）:
 *   香り: 「甘い、熟した香り | リッチ」= rich / 「青い、爽やかな香り | ドライ」= dry
 *   味わい: 「しっかりした味わい | フルボディ」= full / 「すっきりした味わい | ライトボディ」= light
 *
 * フィクスチャ設計（flow1「感想→次の一杯」を決定的にするため）:
 *   11301（緑茶・rich+full）を評価対象にすると、同軸（rich+full）の別銘柄が 11401 / 11501。
 *   selectNextCup は同軸プールを番号昇順で採るため、カルテ無しの次の一杯は必ず 11401 になる。
 *
 * カルテ活用テスト（flow5・監査 #2）用の異種プール:
 *   40101（青茶・rich+full）を同軸プールに 1 銘柄だけ足す。番号は 11401 より大きいので、
 *   カルテ無し（baseline）の次の一杯は 11401 のまま（flow1 / flow4 の baseline を壊さない）。
 *   一方、青茶を好むカルテ（tasteProfile.preferredCategories=["oolong"]）を渡すと、同軸プール内で
 *   40101（青茶）のカテゴリ親和が 11401/11501（緑茶）を上回り、次の一杯が 40101 に変わる
 *   （= カルテが選定に効くことをロードベアリングに示す）。
 */

export const AROMA_RICH = "甘い、熟した香り | リッチ";
export const AROMA_DRY = "青い、爽やかな香り | ドライ";
export const BODY_FULL = "しっかりした味わい | フルボディ";
export const BODY_LIGHT = "すっきりした味わい | ライトボディ";

interface FixtureTea {
  number: string;
  name: string;
  category: string;
  flavorProfiles: string[];
  descShort?: string;
  howToBrew?: string;
}

/** 販売中お茶フィクスチャ（4 銘柄）。 */
export const TEA_FIXTURE: FixtureTea[] = [
  {
    number: "11301",
    name: "煎茶 やまなみ",
    category: "緑茶",
    flavorProfiles: [AROMA_RICH, BODY_FULL],
    descShort: "コクのある旨味と甘い余韻。",
    howToBrew: "70℃のお湯で90秒。",
  },
  {
    number: "11401",
    name: "深蒸し煎茶 みどり",
    category: "緑茶",
    flavorProfiles: [AROMA_RICH, BODY_FULL],
    descShort: "濃厚で香ばしい。",
    howToBrew: "80℃で60秒。",
  },
  {
    number: "11501",
    name: "玉露 しずく",
    category: "緑茶",
    flavorProfiles: [AROMA_RICH, BODY_FULL],
    descShort: "とろりと甘い高級茶。",
    howToBrew: "60℃で120秒。",
  },
  {
    number: "20101",
    name: "和紅茶 あかね",
    category: "紅茶",
    flavorProfiles: [AROMA_DRY, BODY_LIGHT],
    descShort: "軽やかで爽やかな渋み。",
    howToBrew: "95℃で90秒。",
  },
  {
    // カルテ活用テスト用の異種同軸銘柄（青茶・rich+full）。番号 > 11401 で baseline を壊さない。
    number: "40101",
    name: "和烏龍茶 香駿",
    category: "青茶",
    flavorProfiles: [AROMA_RICH, BODY_FULL],
    descShort: "華やかな香りとまろやかな甘み。",
    howToBrew: "90℃で60秒。",
  },
];

function richText(s: string | undefined): { type: string; rich_text: Array<{ plain_text: string }> } {
  return { type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] };
}

/** 1 銘柄を Notion ページ（mapPage が読む実プロパティ名）に変換する。 */
function toNotionPage(tea: FixtureTea): { properties: Record<string, unknown> } {
  return {
    properties: {
      "Menu Name": { type: "title", title: [{ plain_text: tea.number }] },
      "Menu Name - full": richText(tea.name),
      Category: { type: "select", select: { name: tea.category } },
      // ⚠ 末尾スペース付きキー（本番 Notion スキーマの実キー名）。
      "Flavor Profile ": {
        type: "multi_select",
        multi_select: tea.flavorProfiles.map((name) => ({ name })),
      },
      "Menu Description(Short ver.) ": richText(tea.descShort),
      "How to Brew": richText(tea.howToBrew),
      "How-to_Temp(℃)": richText(undefined),
      "How-to_Time(Sec)": richText(undefined),
      "How-to_Water(ml)": richText(undefined),
      楽しみ方: richText(undefined),
      農家の物語: richText(undefined),
    },
  };
}

export interface NotionTeaMock {
  handle(url: string, init?: RequestInit): Promise<Response>;
}

/** Notion Tea Menu クエリのモックを作る。teas 未指定なら TEA_FIXTURE を返す。 */
export function createNotionTeaMock(teas: FixtureTea[] = TEA_FIXTURE): NotionTeaMock {
  async function handle(url: string, _init?: RequestInit): Promise<Response> {
    // databases/<id>/query 以外の Notion エンドポイントは本フローでは未使用。空 results で返す。
    const results = url.includes("/databases/") && url.includes("/query")
      ? teas.map(toNotionPage)
      : [];
    return new Response(
      JSON.stringify({ object: "list", results, has_more: false, next_cursor: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return { handle };
}
