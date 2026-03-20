/**
 * LINE リッチメニュー設定スクリプト（MS6-T2 準拠）。
 *
 * 6 分割メニュー（1200x810px）:
 * | 商品を探す   | 注文確認     | お問い合わせ |
 * | お茶タイプ診断| 記事を読む   | 会員連携     |
 *
 * 「お茶タイプ診断」ボタンは LIFF URL を開き、テイスティングプロフィール画面を起動。
 *
 * 実行:
 *   pnpm setup-richmenu
 *   または
 *   LINE_CHANNEL_ACCESS_TOKEN=xxx LIFF_ID=xxx npx tsx scripts/setup-richmenu.ts
 *
 * 環境変数:
 *   LINE_CHANNEL_ACCESS_TOKEN  — Messaging API チャネルアクセストークン（必須）
 *   LIFF_ID                    — LIFF アプリ ID（省略時は LIFF URL プレースホルダーを使用）
 */

const LINE_API_BASE = "https://api.line.me/v2/bot";

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const liffId = process.env.LIFF_ID;

if (!token) {
  console.error(
    "LINE_CHANNEL_ACCESS_TOKEN が未設定です。\n" +
      "export LINE_CHANNEL_ACCESS_TOKEN=xxxx してから実行してください。"
  );
  process.exit(1);
}

if (!liffId) {
  console.warn(
    "警告: LIFF_ID が未設定です。\n" +
      "「お茶タイプ診断」ボタンは https://liff.line.me/YOUR_LIFF_ID を使用します。\n" +
      "本番運用前に LIFF_ID を設定して再実行してください。"
  );
}

const liffUrl = liffId
  ? `https://liff.line.me/${liffId}`
  : "https://liff.line.me/YOUR_LIFF_ID";

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
};

/**
 * リッチメニュー定義（6 分割 — 1200x810px）
 *
 * レイアウト:
 *   上段 (y=0   〜 y=405): 商品を探す (x=0)   | 注文確認 (x=400)     | お問い合わせ (x=800)
 *   下段 (y=405 〜 y=810): お茶タイプ診断 (x=0)| 記事を読む (x=400)   | 会員連携 (x=800)
 *
 * 各セルサイズ: 400x405
 */
const richMenuBody = {
  size: { width: 1200, height: 810 },
  selected: true,
  name: "elxea メインメニュー v2",
  chatBarText: "メニュー",
  areas: [
    // 上段左: 商品を探す
    {
      bounds: { x: 0, y: 0, width: 400, height: 405 },
      action: {
        type: "message",
        label: "商品を探す",
        text: "おすすめの商品を教えてください",
      },
    },
    // 上段中: 注文確認
    {
      bounds: { x: 400, y: 0, width: 400, height: 405 },
      action: {
        type: "message",
        label: "注文確認",
        text: "注文状況を確認したいです",
      },
    },
    // 上段右: お問い合わせ
    {
      bounds: { x: 800, y: 0, width: 400, height: 405 },
      action: {
        type: "message",
        label: "お問い合わせ",
        text: "スタッフに相談したいです",
      },
    },
    // 下段左: お茶タイプ診断 — LIFF URL を開く
    {
      bounds: { x: 0, y: 405, width: 400, height: 405 },
      action: {
        type: "uri",
        label: "お茶タイプ診断",
        uri: liffUrl,
      },
    },
    // 下段中: 記事を読む
    {
      bounds: { x: 400, y: 405, width: 400, height: 405 },
      action: {
        type: "uri",
        label: "記事を読む",
        uri: "https://elxea.jp/journal",
      },
    },
    // 下段右: 会員連携
    {
      bounds: { x: 800, y: 405, width: 400, height: 405 },
      action: {
        type: "message",
        label: "会員連携",
        text: "アカウントを連携したいです",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

async function listRichMenus(): Promise<Array<{ richMenuId: string; name: string }>> {
  const res = await fetch(`${LINE_API_BASE}/richmenu/list`, { headers });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`リッチメニュー一覧取得失敗 [${res.status}]: ${err}`);
  }
  const data = (await res.json()) as { richmenus: Array<{ richMenuId: string; name: string }> };
  return data.richmenus ?? [];
}

async function deleteRichMenu(richMenuId: string): Promise<void> {
  const res = await fetch(`${LINE_API_BASE}/richmenu/${richMenuId}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn(`  旧メニュー削除失敗 [${res.status}]: ${err}`);
  }
}

async function createRichMenu(): Promise<string> {
  const res = await fetch(`${LINE_API_BASE}/richmenu`, {
    method: "POST",
    headers,
    body: JSON.stringify(richMenuBody),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`リッチメニュー作成失敗 [${res.status}]: ${err}`);
  }

  const data = (await res.json()) as { richMenuId: string };
  return data.richMenuId;
}

async function setDefaultRichMenu(richMenuId: string): Promise<void> {
  const res = await fetch(`${LINE_API_BASE}/user/all/richmenu/${richMenuId}`, {
    method: "POST",
    headers,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`デフォルト設定失敗 [${res.status}]: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("elxea リッチメニューのセットアップを開始します...\n");
  console.log(`LIFF URL: ${liffUrl}\n`);

  // 1. 既存の同名メニューを削除（べき等性）
  console.log("既存のリッチメニューを確認中...");
  const existing = await listRichMenus();
  const stale = existing.filter((m) => m.name === richMenuBody.name);
  if (stale.length > 0) {
    console.log(`  旧バージョンのメニュー ${stale.length} 件を削除します...`);
    for (const menu of stale) {
      await deleteRichMenu(menu.richMenuId);
      console.log(`  削除完了: ${menu.richMenuId}`);
    }
  } else {
    console.log("  既存の同名メニューはありません。");
  }

  // 2. リッチメニュー作成
  console.log("\nリッチメニューを作成中...");
  const richMenuId = await createRichMenu();
  console.log(`  作成完了: ${richMenuId}`);

  // 3. デフォルトに設定
  console.log("\nデフォルトリッチメニューに設定中...");
  await setDefaultRichMenu(richMenuId);
  console.log("  設定完了");

  // 4. 完了レポート
  console.log("\n" + "=".repeat(60));
  console.log("セットアップ完了");
  console.log("=".repeat(60));
  console.log(`Rich Menu ID: ${richMenuId}`);
  console.log(`LIFF URL    : ${liffUrl}`);
  console.log("\n次のステップ:");
  console.log("  1. LINE Official Account Manager でリッチメニュー画像をアップロード");
  console.log(`     Rich Menu ID: ${richMenuId}`);
  console.log("  2. 推奨画像サイズ: 1200x810px");
  console.log("  3. 6 分割レイアウト（上段3 + 下段3）のデザインで作成");
  console.log("     上段: 商品を探す | 注文確認 | お問い合わせ");
  console.log("     下段: お茶タイプ診断 | 記事を読む | 会員連携");
  if (!liffId) {
    console.log("\n  ⚠️  LIFF_ID を設定してから再実行してください:");
    console.log("     LIFF_ID=xxx pnpm setup-richmenu");
  }
}

main().catch((err) => {
  console.error("エラー:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
