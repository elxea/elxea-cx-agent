/**
 * LINE リッチメニュー設定スクリプト。
 *
 * 6 分割メニュー:
 * | 商品を探す | 注文確認   | お問い合わせ |
 * | おすすめ   | 記事を読む | ヘルプ       |
 *
 * 実行: pnpm setup-rich-menu
 *
 * 注意:
 * - LINE_CHANNEL_ACCESS_TOKEN が環境変数に必要
 * - リッチメニュー画像は LINE Official Account Manager で別途設定
 *   （このスクリプトはメニュー構造のみ作成）
 */

const LINE_API_BASE = "https://api.line.me/v2/bot";

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) {
  console.error(
    "❌ LINE_CHANNEL_ACCESS_TOKEN が未設定です。\n" +
      "   export LINE_CHANNEL_ACCESS_TOKEN=xxxx してから実行してください。",
  );
  process.exit(1);
}

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
    // 上段左: 商品を探す
    {
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: { type: "message", text: "おすすめの商品を教えてください" },
    },
    // 上段中: 注文確認
    {
      bounds: { x: 833, y: 0, width: 834, height: 843 },
      action: { type: "message", text: "注文状況を確認したいです" },
    },
    // 上段右: お問い合わせ
    {
      bounds: { x: 1667, y: 0, width: 833, height: 843 },
      action: { type: "message", text: "スタッフに相談したいです" },
    },
    // 下段左: おすすめ
    {
      bounds: { x: 0, y: 843, width: 833, height: 843 },
      action: { type: "message", text: "今おすすめのお茶はありますか？" },
    },
    // 下段中: 記事を読む
    {
      bounds: { x: 833, y: 843, width: 834, height: 843 },
      action: {
        type: "uri",
        uri: "https://elxea.jp/journal",
        label: "記事を読む",
      },
    },
    // 下段右: ヘルプ
    {
      bounds: { x: 1667, y: 843, width: 833, height: 843 },
      action: { type: "message", text: "使い方を教えてください" },
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
