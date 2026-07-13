/**
 * ⚠⚠⚠ 廃止（DEPRECATED 2026-07-13）⚠⚠⚠
 * この 6 分割スクリプトは使用しないこと。リッチメニューの「正」は 5 枠版
 * scripts/setup-rich-menu.ts（pnpm setup-rich-menu）。二重管理を避けるため本ファイルは
 * 実行をブロックする（下部の即時 exit を参照）。内容は履歴目的で残置。
 *
 * LINE リッチメニュー設定スクリプト（構成設計 2026-07-11 準拠 / pull 型「茶室の入口」）。
 *
 * 6 分割メニュー（1200x810px）:
 * | ① 淹れ方を知る | ② つくり手・産地の物語 | ③ 好み診断 |
 * | ④ 相談する     | ⑤ 季節の便り・読みもの | ⑥ 定期便・注文照会 |
 *
 * アクション方針（オーナー確定 2026-07-11）:
 * - ページ遷移系（②⑤）は elxea-web-app の実在ルートへ。正規ドメインは https://elxea.com
 *   （web-app の sitemap.ts / robots.ts / layout hreflang が SoT）、ロケールは /ja
 *   （i18n/config.ts defaultLocale = "ja"）。旧 elxea.jp は実在せず廃止。
 * - LINE 内対話系（③好み診断・④相談・⑥注文照会）は Web に飛ばさず message アクションで
 *   ユーザーの自然発話を送信し、CX エージェント（webhook → runAgent）との会話を自然に開始する。
 *   message は src/routes/line.ts の handleMessage → handleTextMessage → runAgent で処理される。
 *   postback ハンドラは未実装のため message を採用。③好み診断は旧 LIFF 起動をやめ message へ変更。
 * - ①淹れ方を知る は専用ページ未実在（brew/how-to 単独ページ無し）。404 回避のため準備中扱いとし、
 *   淹れ方について CX エージェントと対話が始まる message アクションにする。
 *
 * 実行:
 *   pnpm setup-richmenu
 *   または
 *   LINE_CHANNEL_ACCESS_TOKEN=xxx npx tsx scripts/setup-richmenu.ts
 *
 * 環境変数:
 *   LINE_CHANNEL_ACCESS_TOKEN  — Messaging API チャネルアクセストークン（必須）
 *
 * 注: 本構成は全 6 マスが message / uri アクションで完結し、LIFF は使用しない。
 */

// --- DEPRECATED guard: 5 枠版に一本化。誤実行を防ぐため即時停止する ---
console.error(
  "⛔ scripts/setup-richmenu.ts は廃止されました（旧 6 分割）。\n" +
    "   リッチメニューの正は 5 枠版です: pnpm setup-rich-menu（scripts/setup-rich-menu.ts）。\n" +
    "   どうしても旧 6 分割を再現する必要がある場合のみ、この guard を一時的に外して実行してください。",
);
process.exit(1);

const LINE_API_BASE = "https://api.line.me/v2/bot";

/** 正規サイト（web-app の SoT）— ドメイン + ロケール */
const SITE_URL = "https://elxea.com/ja";

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!token) {
  console.error(
    "LINE_CHANNEL_ACCESS_TOKEN が未設定です。\n" +
      "export LINE_CHANNEL_ACCESS_TOKEN=xxxx してから実行してください。"
  );
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
};

/**
 * リッチメニュー定義（6 分割 — 1200x810px / 構成設計 2026-07-11）
 *
 * レイアウト:
 *   上段 (y=0   〜 y=405): ① 淹れ方を知る (x=0) | ② つくり手・産地の物語 (x=400) | ③ 好み診断 (x=800)
 *   下段 (y=405 〜 y=810): ④ 相談する (x=0)     | ⑤ 季節の便り・読みもの (x=400) | ⑥ 定期便・注文照会 (x=800)
 *
 * 各セルサイズ: 400x405
 */
const richMenuBody = {
  size: { width: 1200, height: 810 },
  selected: true,
  name: "elxea メインメニュー v2",
  chatBarText: "メニュー",
  areas: [
    // 上段左: ① 淹れ方を知る（準備中: 専用ページ未実在 → CX 対話で 404 回避）
    {
      bounds: { x: 0, y: 0, width: 400, height: 405 },
      action: {
        type: "message",
        label: "淹れ方を知る",
        text: "お茶のおいしい淹れ方を教えてください",
      },
    },
    // 上段中: ② つくり手・産地の物語（実在ページ /ja/farmers へ遷移）
    {
      bounds: { x: 400, y: 0, width: 400, height: 405 },
      action: {
        type: "uri",
        label: "つくり手・産地の物語",
        uri: `${SITE_URL}/farmers`,
      },
    },
    // 上段右: ③ 好み診断（LINE 内で CX 対話を開始）
    {
      bounds: { x: 800, y: 0, width: 400, height: 405 },
      action: {
        type: "message",
        label: "好み診断",
        text: "好みに合うお茶を診断してほしいです",
      },
    },
    // 下段左: ④ 相談する（LINE 内で CX 対話を開始）
    {
      bounds: { x: 0, y: 405, width: 400, height: 405 },
      action: {
        type: "message",
        label: "相談する",
        text: "相談したいことがあります",
      },
    },
    // 下段中: ⑤ 季節の便り・読みもの（実在ページ /ja/journal へ遷移）
    {
      bounds: { x: 400, y: 405, width: 400, height: 405 },
      action: {
        type: "uri",
        label: "季節の便り・読みもの",
        uri: `${SITE_URL}/journal`,
      },
    },
    // 下段右: ⑥ 定期便・注文照会（注文照会は問い合わせ系 → LINE 内で CX 対話を開始）
    {
      bounds: { x: 800, y: 405, width: 400, height: 405 },
      action: {
        type: "message",
        label: "定期便・注文照会",
        text: "最近の注文と定期便の状況を教えてください",
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
  console.log("\n次のステップ:");
  console.log("  1. LINE Official Account Manager でリッチメニュー画像をアップロード");
  console.log(`     Rich Menu ID: ${richMenuId}`);
  console.log("  2. 推奨画像サイズ: 1200x810px");
  console.log("  3. 6 分割レイアウト（上段3 + 下段3）のデザインで作成");
  console.log("     上段: 淹れ方を知る | つくり手・産地の物語 | 好み診断");
  console.log("     下段: 相談する | 季節の便り・読みもの | 定期便・注文照会");
}

main().catch((err) => {
  console.error("エラー:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

export {};
