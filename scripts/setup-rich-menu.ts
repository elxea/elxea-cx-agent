/**
 * LINE リッチメニュー設定スクリプト（5 枠版・オーナー確定 2026-07-13）。
 *
 * ⚠ このスクリプトが「正」。旧 scripts/setup-richmenu.ts（6 分割）は廃止。二重管理しないこと。
 *
 * 5 枠レイアウト（2500x1686px）:
 *   上段（各 833x843・3 枠）: ① お茶の淹れ方 | ② 好み診断 | ③ 相談
 *   下段（各 1250x843・2 枠）: ④ 定期便            | ⑤ elxea について
 *
 * アクション方針（オーナー確定 2026-07-13・全枠 message アクション / postback 未実装のため）:
 *   すべて message アクションでユーザーの自然発話を送信し、CX エージェント（webhook →
 *   src/routes/line.ts handleTextMessage）で決定的に処理する。各枠の応答フロー:
 *     ① "お茶の淹れ方を知りたい"          → tea-menu.ts の入口（販売中のお茶を一覧・3 タップ以内）
 *     ② "好みに合うお茶を診断してほしいです" → 既存 AI 会話（好み診断）へ素通り
 *     ③ "相談したいことがあります"          → menu-actions.ts が初手 quick reply を提示（以降 AI 会話）
 *     ④ "定期便について知りたい"            → menu-actions.ts が Shopify 連携 × isSubscriber で出し分け
 *     ⑤ "elxeaについて教えて"               → menu-actions.ts がブランド紹介 1 通
 *   ①③④⑤ のトリガー文言は各インターセプタの完全一致トリガーと一致させること（整合必須）。
 *
 * 実行: pnpm setup-rich-menu
 *   （※ 画像は別途 LINE Official Account Manager でアップロード。本スクリプトは構造のみ作成）
 *
 * チャネル選択（取り違え防止・テスト優先の fail-safe）:
 *   - LINE_CHANNEL_ACCESS_TOKEN_TEST があればテスト OA（@426vlcyb）に載せる（staging 既定）。
 *   - 本番 OA（@307tzhkw）に載せたいときは *_TEST を unset し LINE_CHANNEL_ACCESS_TOKEN を export。
 *   - どちらに載せるかを起動時にラベル表示する（トークン値は絶対に出さない）。
 */

const LINE_API_BASE = "https://api.line.me/v2/bot";

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

/** リッチメニュー名（べき等な差し替えのキーにも使う）。 */
const MENU_NAME = "elxea メインメニュー（5 枠）";

/** リッチメニュー定義（5 枠 — 2500x1686px） */
const richMenuBody = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: MENU_NAME,
  chatBarText: "メニュー",
  areas: [
    // 上段左: ① お茶の淹れ方（tea-menu 入口 = ENTRY_PHRASES と一致）
    {
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: {
        type: "message",
        label: "お茶の淹れ方",
        text: "お茶の淹れ方を知りたい",
      },
    },
    // 上段中: ② 好み診断（既存 AI 会話へ）
    {
      bounds: { x: 833, y: 0, width: 833, height: 843 },
      action: {
        type: "message",
        label: "好み診断",
        text: "好みに合うお茶を診断してほしいです",
      },
    },
    // 上段右: ③ 相談（menu-actions の初手 quick reply = CONSULTATION_TRIGGER と一致）
    {
      bounds: { x: 1666, y: 0, width: 834, height: 843 },
      action: {
        type: "message",
        label: "相談",
        text: "相談したいことがあります",
      },
    },
    // 下段左: ④ 定期便（menu-actions の出し分け = SUBSCRIPTION_TRIGGER と一致）
    {
      bounds: { x: 0, y: 843, width: 1250, height: 843 },
      action: {
        type: "message",
        label: "定期便",
        text: "定期便について知りたい",
      },
    },
    // 下段右: ⑤ elxea について（menu-actions の紹介 = ABOUT_TRIGGER と一致）
    {
      bounds: { x: 1250, y: 843, width: 1250, height: 843 },
      action: {
        type: "message",
        label: "elxea について",
        text: "elxeaについて教えて",
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
    throw new Error(`リッチメニュー一覧取得失敗 [${res.status}]: ${await res.text()}`);
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
    console.warn(`  旧メニュー削除失敗 [${res.status}]: ${await res.text()}`);
  }
}

async function main() {
  console.log("📋 リッチメニュー（5 枠）をセットアップします...\n");

  // 1. 既存の同名メニューを削除（べき等性）
  console.log("既存の同名メニューを確認中...");
  const existing = await listRichMenus();
  const stale = existing.filter((m) => m.name === MENU_NAME);
  if (stale.length > 0) {
    console.log(`  同名メニュー ${stale.length} 件を削除します...`);
    for (const menu of stale) {
      await deleteRichMenu(menu.richMenuId);
      console.log(`  削除完了: ${menu.richMenuId}`);
    }
  } else {
    console.log("  既存の同名メニューはありません。");
  }

  // 2. リッチメニュー作成
  console.log("\nリッチメニューを作成中...");
  const createRes = await fetch(`${LINE_API_BASE}/richmenu`, {
    method: "POST",
    headers,
    body: JSON.stringify(richMenuBody),
  });
  if (!createRes.ok) {
    console.error(`❌ リッチメニュー作成失敗 [${createRes.status}]:`, await createRes.text());
    process.exit(1);
  }
  const { richMenuId } = (await createRes.json()) as { richMenuId: string };
  console.log(`✅ 作成完了: ${richMenuId}`);

  // 3. デフォルトに設定
  console.log("\nデフォルトリッチメニューに設定中...");
  const defaultRes = await fetch(
    `${LINE_API_BASE}/user/all/richmenu/${richMenuId}`,
    { method: "POST", headers },
  );
  if (!defaultRes.ok) {
    console.error(
      `⚠️  デフォルト設定失敗 [${defaultRes.status}]:`,
      await defaultRes.text(),
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
      `   3. 5 枠レイアウト（上段3=各833×843 / 下段2=各1250×843）:\n` +
      `      上段: お茶の淹れ方 | 好み診断 | 相談\n` +
      `      下段: 定期便 | elxea について`,
  );
}

main().catch((err) => {
  console.error("エラー:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

export {};
