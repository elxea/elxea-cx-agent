/**
 * LINE リッチメニュー設定スクリプト（6 枠 Option A・オーナー確定 2026-07-20）。
 *
 * ⚠ このスクリプトが「正」。旧 scripts/setup-richmenu.ts（6 分割）は廃止。二重管理しないこと。
 *
 * 6 枠レイアウト（2500x1686px・2×3 グリッド・各枠 833×843）:
 *   上段（3 枠）: ① お茶の淹れ方 | ② 好み診断 | ③ マイカルテ
 *   下段（3 枠）: ④ 定期便       | ⑤ 読みもの | ⑥ elxea について
 *   （旧 5 枠版の「相談」を削除し、③ マイカルテ・⑤ 読みもの を新設。★=新規）
 *   ※ 列幅は 833 / 833 / 834（合計 2500）。右列のみ 834 で端数を吸収する。
 *
 * アクション方針（全枠 message アクション / postback 未実装のため）:
 *   すべて message アクションでユーザーの自然発話を送信し、CX エージェント（webhook →
 *   src/routes/line.ts）で決定的に処理する。各枠のトリガー文言は実装側の完全一致トリガーと
 *   一致させること（整合必須）:
 *     ① "お茶の淹れ方を知りたい"          → src/lib/menu-tap.ts BREW_RICH_MENU_TRIGGER（tea-menu 入口）
 *     ② "好みに合うお茶を診断してほしいです" → src/lib/preference-diagnosis.ts DIAGNOSIS_TRIGGER
 *     ③ "マイカルテ"                       → src/routes/line.ts マイカルテ完全一致（customer-karte・read-only）
 *     ④ "定期便について知りたい"            → src/lib/menu-actions.ts SUBSCRIPTION_TRIGGER
 *     ⑤ "読みもの"                         → src/lib/journal.ts READING_TRIGGER
 *     ⑥ "elxeaについて教えて"               → src/lib/menu-actions.ts ABOUT_TRIGGER
 *
 * 実行: pnpm setup-rich-menu
 *   - 構造（枠・アクション）を作成し、既定リッチメニューに設定する。
 *   - 画像は環境変数 RICH_MENU_IMAGE_PATH が指す PNG を自動アップロードする（未指定なら構造のみ作成し、
 *     画像は別途 LINE Official Account Manager でアップロードする）。
 *
 * チャネル選択（取り違え防止・テスト優先の fail-safe）:
 *   - LINE_CHANNEL_ACCESS_TOKEN_TEST があればテスト OA（@426vlcyb）に載せる（staging 既定）。
 *   - 本番 OA（@307tzhkw）に載せたいときは *_TEST を unset し LINE_CHANNEL_ACCESS_TOKEN を export。
 *   - どちらに載せるかを起動時にラベル表示する（トークン値は絶対に出さない）。
 */

import { readFileSync } from "node:fs";

const LINE_API_BASE = "https://api.line.me/v2/bot";
const LINE_API_DATA_BASE = "https://api-data.line.me/v2/bot";

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
const MENU_NAME = "elxea メインメニュー（6 枠 Option A）";

/** リッチメニュー定義（6 枠 — 2500x1686px・2×3・各 833×843 / 右列のみ 834） */
const richMenuBody = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: MENU_NAME,
  chatBarText: "メニュー",
  areas: [
    // 上段左: ① お茶の淹れ方（tea-menu 入口 = menu-tap.ts BREW_RICH_MENU_TRIGGER と一致）
    {
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: {
        type: "message",
        label: "お茶の淹れ方",
        text: "お茶の淹れ方を知りたい",
      },
    },
    // 上段中: ② 好み診断（preference-diagnosis.ts DIAGNOSIS_TRIGGER と一致）
    {
      bounds: { x: 833, y: 0, width: 833, height: 843 },
      action: {
        type: "message",
        label: "好み診断",
        text: "好みに合うお茶を診断してほしいです",
      },
    },
    // 上段右: ③ マイカルテ（★新規 = routes/line.ts の「マイカルテ」完全一致・customer-karte read-only）
    {
      bounds: { x: 1666, y: 0, width: 834, height: 843 },
      action: {
        type: "message",
        label: "マイカルテ",
        text: "マイカルテ",
      },
    },
    // 下段左: ④ 定期便（menu-actions.ts SUBSCRIPTION_TRIGGER と一致）
    {
      bounds: { x: 0, y: 843, width: 833, height: 843 },
      action: {
        type: "message",
        label: "定期便",
        text: "定期便について知りたい",
      },
    },
    // 下段中: ⑤ 読みもの（★新規 = journal.ts READING_TRIGGER と一致）
    {
      bounds: { x: 833, y: 843, width: 833, height: 843 },
      action: {
        type: "message",
        label: "読みもの",
        text: "読みもの",
      },
    },
    // 下段右: ⑥ elxea について（menu-actions.ts ABOUT_TRIGGER と一致）
    {
      bounds: { x: 1666, y: 843, width: 834, height: 843 },
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

/** 画像を content エンドポイントへアップロード（RICH_MENU_IMAGE_PATH 指定時のみ）。 */
async function uploadImage(richMenuId: string, imagePath: string): Promise<boolean> {
  const bytes = readFileSync(imagePath);
  const res = await fetch(`${LINE_API_DATA_BASE}/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      Authorization: `Bearer ${token}`,
    },
    body: bytes,
  });
  if (!res.ok) {
    console.error(`❌ 画像アップロード失敗 [${res.status}]:`, await res.text());
    return false;
  }
  return true;
}

async function main() {
  console.log("📋 リッチメニュー（6 枠 Option A）をセットアップします...\n");

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

  // 3. 画像アップロード（RICH_MENU_IMAGE_PATH 指定時のみ・未指定なら手動アップロード）
  const imagePath = process.env.RICH_MENU_IMAGE_PATH;
  let imageUploaded = false;
  if (imagePath) {
    console.log(`\n画像をアップロード中... (${imagePath})`);
    imageUploaded = await uploadImage(richMenuId, imagePath);
    if (imageUploaded) console.log("✅ 画像アップロード完了");
  } else {
    console.log(
      "\nℹ️  RICH_MENU_IMAGE_PATH 未指定のため画像アップロードはスキップ。" +
        "\n   画像は LINE Official Account Manager から手動でアップロードしてください。",
    );
  }

  // 4. デフォルトに設定
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
      (imageUploaded
        ? `   画像アップロード済み。Rich Menu ID: ${richMenuId}\n`
        : `   1. LINE Official Account Manager でリッチメニュー画像をアップロード\n` +
          `      Rich Menu ID: ${richMenuId}\n` +
          `      画像サイズ: 2500x1686px\n`) +
      `   6 枠レイアウト（2×3・各 833×843 / 右列 834）:\n` +
      `      上段: お茶の淹れ方 | 好み診断 | マイカルテ\n` +
      `      下段: 定期便 | 読みもの | elxea について`,
  );
}

main().catch((err) => {
  console.error("エラー:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

export {};
