/**
 * LINE リッチメニュー設定スクリプト。
 *
 * 6 分割メニュー（構成設計 2026-07-11 準拠 / pull 型「茶室の入口」）:
 * | ① 淹れ方を知る | ② つくり手・産地の物語 | ③ 好み診断 |
 * | ④ 相談する     | ⑤ 季節の便り・読みもの | ⑥ 定期便・注文照会 |
 *
 * アクション方針（オーナー確定 2026-07-11）:
 * - ページ遷移系（②⑤）は elxea-web-app の実在ルートへ。正規ドメインは
 *   https://elxea.com（web-app の sitemap.ts / robots.ts / layout hreflang が SoT）、
 *   ロケールは /ja（i18n/config.ts defaultLocale = "ja"）。旧 elxea.jp は実在せず廃止。
 * - LINE 内対話系（③好み診断・④相談・⑥注文照会）は Web に飛ばさず、message アクションで
 *   ユーザーの自然発話を送信し、CX エージェント（webhook → runAgent）との会話を自然に開始する。
 *   message イベントは src/routes/line.ts の handleMessage → handleTextMessage → runAgent で処理される。
 *   postback ハンドラは未実装（processEvents は message/follow/unfollow のみ）のため message を採用。
 * - ①淹れ方を知る は専用の「淹れ方」ページが web-app に未実在（brew/how-to 単独ページ無し・
 *   淹れ方ガイドは tea-menu 各詳細ページ内のセクションのみ）。404 回避のため準備中扱いとし、
 *   淹れ方について CX エージェントと対話が始まる message アクションにする。
 *
 * 実行: pnpm setup-rich-menu
 *
 * 注意:
 * - チャネルアクセストークンが環境変数に必要（下記「チャネル選択」参照）
 * - リッチメニュー画像は LINE Official Account Manager で別途設定
 *   （このスクリプトはメニュー構造のみ作成）
 *
 * チャネル選択（取り違え防止・テスト優先の fail-safe）:
 * - リッチメニューは「渡したトークンのチャネル」に載る。staging 検証では必ず
 *   テスト OA（@426vlcyb）に載せたいので、LINE_CHANNEL_ACCESS_TOKEN_TEST があれば
 *   それを優先する（src/lib/delivery-channel.ts の test 既定と整合）。
 * - 本番 OA（@307tzhkw）に載せたいときは *_TEST を unset し、
 *   LINE_CHANNEL_ACCESS_TOKEN を export して実行する。
 * - どちらのチャネルに載せるかを起動時にラベル表示する（トークン値は絶対に出さない）。
 */

const LINE_API_BASE = "https://api.line.me/v2/bot";

/** 正規サイト（web-app の SoT）— ドメイン + ロケール */
const SITE_URL = "https://elxea.com/ja";

// テスト優先: *_TEST があればテスト OA に載せる（staging 既定）。無ければ本番トークンにフォールバック。
const testToken = process.env.LINE_CHANNEL_ACCESS_TOKEN_TEST;
const prodToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const token = testToken ?? prodToken;
const channelLabel = testToken ? "test(@426vlcyb)" : "prod(@307tzhkw)";
if (!token) {
  console.error(
    "❌ チャネルアクセストークンが未設定です。\n" +
      "   staging（テスト OA）: export LINE_CHANNEL_ACCESS_TOKEN_TEST=xxxx\n" +
      "   本番 OA:              export LINE_CHANNEL_ACCESS_TOKEN=xxxx\n" +
      "   いずれかを設定してから実行してください。",
  );
  process.exit(1);
}
console.log(`🎯 対象チャネル: ${channelLabel}（トークンは表示しません）`);

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
};

/** リッチメニュー定義（6 分割 — 2500x1686px 想定） */
const richMenuBody = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: "elxea メインメニュー",
  chatBarText: "メニュー",
  areas: [
    // 上段左: ① 淹れ方を知る（準備中: 専用ページ未実在 → CX 対話で 404 回避）
    {
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: {
        type: "message",
        label: "淹れ方を知る",
        text: "お茶のおいしい淹れ方を教えてください",
      },
    },
    // 上段中: ② つくり手・産地の物語（実在ページ /ja/farmers へ遷移）
    {
      bounds: { x: 833, y: 0, width: 834, height: 843 },
      action: {
        type: "uri",
        label: "つくり手・産地の物語",
        uri: `${SITE_URL}/farmers`,
      },
    },
    // 上段右: ③ 好み診断（LINE 内で CX 対話を開始）
    {
      bounds: { x: 1667, y: 0, width: 833, height: 843 },
      action: {
        type: "message",
        label: "好み診断",
        text: "好みに合うお茶を診断してほしいです",
      },
    },
    // 下段左: ④ 相談する（LINE 内で CX 対話を開始）
    {
      bounds: { x: 0, y: 843, width: 833, height: 843 },
      action: {
        type: "message",
        label: "相談する",
        text: "相談したいことがあります",
      },
    },
    // 下段中: ⑤ 季節の便り・読みもの（実在ページ /ja/journal へ遷移）
    {
      bounds: { x: 833, y: 843, width: 834, height: 843 },
      action: {
        type: "uri",
        label: "季節の便り・読みもの",
        uri: `${SITE_URL}/journal`,
      },
    },
    // 下段右: ⑥ 定期便・注文照会（注文照会は問い合わせ系 → LINE 内で CX 対話を開始）
    {
      bounds: { x: 1667, y: 843, width: 833, height: 843 },
      action: {
        type: "message",
        label: "定期便・注文照会",
        text: "最近の注文と定期便の状況を教えてください",
      },
    },
  ],
};

async function main() {
  console.log("📋 リッチメニューを作成中...");

  // 1. リッチメニュー作成
  const createRes = await fetch(`${LINE_API_BASE}/richmenu`, {
    method: "POST",
    headers,
    body: JSON.stringify(richMenuBody),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    console.error(`❌ リッチメニュー作成失敗 [${createRes.status}]:`, err);
    process.exit(1);
  }

  const { richMenuId } = (await createRes.json()) as { richMenuId: string };
  console.log(`✅ リッチメニュー作成完了: ${richMenuId}`);

  // 2. デフォルトに設定
  console.log("📌 デフォルトリッチメニューに設定中...");
  const defaultRes = await fetch(
    `${LINE_API_BASE}/user/all/richmenu/${richMenuId}`,
    { method: "POST", headers },
  );

  if (!defaultRes.ok) {
    const err = await defaultRes.text();
    console.error(
      `⚠️  デフォルト設定失敗 [${defaultRes.status}]:`,
      err,
      "\n   画像をアップロードしてから再度デフォルト設定してください。",
    );
  } else {
    console.log("✅ デフォルトリッチメニュー設定完了");
  }

  console.log(
    "\n📎 次のステップ:\n" +
      `   1. LINE Official Account Manager でリッチメニュー画像をアップロード\n` +
      `      Rich Menu ID: ${richMenuId}\n` +
      `   2. 画像サイズ: 2500x1686px\n` +
      `   3. 6 分割（上段3 + 下段3）のデザインで作成`,
  );
}

main().catch(console.error);

export {};
