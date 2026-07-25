/**
 * LINE リッチメニュー設定スクリプト（6 枠 Option A・オーナー確定 2026-07-20）。
 *
 * ⚠ このスクリプトが「正」。旧 scripts/setup-richmenu.ts（6 分割）は削除済み。二重管理しないこと。
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
 * 実行: pnpm setup-rich-menu -- --channel prod|test
 *   - 順序（空白の窓を作らない・QA 指摘の修正）: create → image upload → set-default(new) → delete-old。
 *   - 画像は環境変数 RICH_MENU_IMAGE_PATH が指す PNG を自動アップロードする。未指定/失敗時は既定化できない
 *     ため旧メニューを削除せず維持する（旧が既定のまま＝ユーザー側に空白の窓が出ない）。
 *
 * チャネル選択（取り違え防止・明示必須／silent fallback 廃止）:
 *   - `--channel prod|test` を **必須引数**にする。明示なしは中断（`token = testToken ?? prodToken`
 *     の暗黙フォールバックは取り違え事故の元だったため廃止した）。
 *   - `--channel test`: テスト OA（@426vlcyb）に載せる。LINE_CHANNEL_ACCESS_TOKEN_TEST を要求。
 *   - `--channel prod`: 本番 OA（@307tzhkw）に載せる。LINE_CHANNEL_ACCESS_TOKEN を要求。
 *   - 選択したチャネルに対応するトークンが未設定なら中断（別チャネルのトークンには決して倒さない）。
 *   - どちらに載せるかを起動時にラベル表示する（トークン値は絶対に出さない）。
 */

import { readFileSync } from "node:fs";

const LINE_API_BASE = "https://api.line.me/v2/bot";
const LINE_API_DATA_BASE = "https://api-data.line.me/v2/bot";

// チャネルは --channel prod|test で明示必須（silent fallback 廃止・取り違え防止）。
const channelArg = process.argv
  .slice(2)
  .find((a) => a === "--channel" || a.startsWith("--channel="));
const channelValue = channelArg
  ? channelArg.includes("=")
    ? channelArg.split("=")[1]
    : process.argv[process.argv.indexOf(channelArg) + 1]
  : undefined;

if (channelValue !== "prod" && channelValue !== "test") {
  console.error(
    "❌ --channel が未指定または不正です（silent fallback は廃止しました）。\n" +
      "   テスト OA（@426vlcyb）: pnpm setup-rich-menu -- --channel test\n" +
      "     （要 export LINE_CHANNEL_ACCESS_TOKEN_TEST=xxxx）\n" +
      "   本番 OA（@307tzhkw）:   pnpm setup-rich-menu -- --channel prod\n" +
      "     （要 export LINE_CHANNEL_ACCESS_TOKEN=xxxx）\n" +
      "   どちらのチャネルに載せるかを必ず明示してください。",
  );
  process.exit(1);
}

const testToken = process.env.LINE_CHANNEL_ACCESS_TOKEN_TEST;
const prodToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
// 選択したチャネルのトークンのみを使う。別チャネルのトークンには決して倒さない。
const token = channelValue === "test" ? testToken : prodToken;
const channelLabel = channelValue === "test" ? "test(@426vlcyb)" : "prod(@307tzhkw)";
if (!token) {
  const needEnv =
    channelValue === "test"
      ? "LINE_CHANNEL_ACCESS_TOKEN_TEST"
      : "LINE_CHANNEL_ACCESS_TOKEN";
  console.error(
    `❌ --channel ${channelValue} を指定しましたが ${needEnv} が未設定です。\n` +
      `   export ${needEnv}=xxxx を設定してから実行してください（別チャネルのトークンには倒しません）。`,
  );
  process.exit(1);
}
console.log(`🎯 対象チャネル: ${channelLabel}（--channel ${channelValue} 明示・トークンは表示しません）`);

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

/** 指定メニューを全ユーザーの既定リッチメニューに設定する。成否を返す。 */
async function setDefaultRichMenu(richMenuId: string): Promise<boolean> {
  const res = await fetch(`${LINE_API_BASE}/user/all/richmenu/${richMenuId}`, {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    console.error(`❌ デフォルト設定失敗 [${res.status}]:`, await res.text());
    return false;
  }
  return true;
}

/**
 * 「空白の窓」を作らない順序で差し替える（QA 指摘の修正）:
 *   create → image upload → set-default(new) → delete-old
 *
 * ⚠ なぜこの順序か:
 *   - LINE は「画像がアップロード済みのメニュー」しか既定に設定できない。旧実装は
 *     「旧削除 → 新作成」だったため、新メニューが既定になる前に旧メニューを消し、その間ユーザーには
 *     メニューが出ない**空白の窓**が生じた。さらに画像未指定/失敗時は新メニューを既定化できず、
 *     旧削除済みのまま窓が**継続**した。
 *   - 本実装は「新作成 → 画像 → 既定化 → 旧削除」に直し、**新メニューが既定になってから**旧を消す。
 *     画像未指定/失敗のときは旧メニューを**一切消さず**（旧が既定のまま維持）、手動アップロード手順を案内する。
 */
async function main() {
  console.log("📋 リッチメニュー（6 枠 Option A）をセットアップします...\n");

  // 1. 既存の同名メニューを「後で消す候補」として控える（ここでは消さない = 空白の窓を作らない）。
  console.log("既存の同名メニューを確認中...");
  const existing = await listRichMenus();
  const staleBefore = existing.filter((m) => m.name === MENU_NAME);
  if (staleBefore.length > 0) {
    console.log(`  同名の旧メニュー ${staleBefore.length} 件を検出（新メニュー既定化の後に削除します）。`);
  } else {
    console.log("  既存の同名メニューはありません。");
  }

  // 2. リッチメニュー作成（まだ既定にしない）。
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

  // 新メニュー自身は削除対象から必ず除外する（同名のため）。
  const staleToDelete = staleBefore.filter((m) => m.richMenuId !== richMenuId);

  // 3. 画像アップロード（RICH_MENU_IMAGE_PATH 指定時のみ）。
  const imagePath = process.env.RICH_MENU_IMAGE_PATH;
  if (!imagePath) {
    // 画像が無いと既定化できない → 旧メニューは消さず維持する（窓を開けない）。
    console.log(
      "\nℹ️  RICH_MENU_IMAGE_PATH 未指定。画像なしでは既定化できないため、旧メニューは削除せず維持します。\n" +
        "   （旧メニューが既定のまま残る＝ユーザー側に空白の窓は生じません。）\n" +
        "   次の手順:\n" +
        `     1. LINE Official Account Manager で新メニュー（Rich Menu ID: ${richMenuId}）に画像をアップロード（2500x1686px）\n` +
        "     2. アップロード後、RICH_MENU_IMAGE_PATH を指定して本スクリプトを再実行するか、\n" +
        "        OA Manager 上で新メニューを既定に切り替える。既定切替後に旧メニューを削除する。",
    );
    return;
  }

  console.log(`\n画像をアップロード中... (${imagePath})`);
  const imageUploaded = await uploadImage(richMenuId, imagePath);
  if (!imageUploaded) {
    // 画像アップロード失敗 → 既定化不能。旧メニューは消さない（窓を開けない）。中断。
    console.error(
      "\n❌ 画像アップロードに失敗しました。既定化できないため中断します。\n" +
        "   旧メニューは削除していません（既定のまま維持＝空白の窓なし）。\n" +
        `   作成済みの新メニュー（Rich Menu ID: ${richMenuId}）は画像未設定のまま残ります。` +
        "画像を用意して再実行してください。",
    );
    process.exit(1);
  }
  console.log("✅ 画像アップロード完了");

  // 4. 新メニューを既定化（ここで初めて切り替わる）。
  console.log("\nデフォルトリッチメニューに設定中...");
  const defaulted = await setDefaultRichMenu(richMenuId);
  if (!defaulted) {
    // 既定化に失敗 → 旧メニューは消さない（旧が既定のまま＝窓なし）。中断。
    console.error(
      "\n❌ 既定化に失敗しました。旧メニューは削除していません（旧が既定のまま＝空白の窓なし）。中断します。",
    );
    process.exit(1);
  }
  console.log("✅ デフォルトリッチメニュー設定完了");

  // 5. 新メニューが既定になった後で、初めて旧メニューを削除する（ここまで窓は開かない）。
  if (staleToDelete.length > 0) {
    console.log(`\n旧メニュー ${staleToDelete.length} 件を削除します（新メニューは既に既定）...`);
    for (const menu of staleToDelete) {
      await deleteRichMenu(menu.richMenuId);
      console.log(`  削除完了: ${menu.richMenuId}`);
    }
  }

  console.log(
    "\n✅ 差し替え完了（空白の窓なし: 新既定化 → 旧削除の順）。\n" +
      `   Rich Menu ID: ${richMenuId}\n` +
      "   6 枠レイアウト（2×3・各 833×843 / 右列 834）:\n" +
      "      上段: お茶の淹れ方 | 好み診断 | マイカルテ\n" +
      "      下段: 定期便 | 読みもの | elxea について",
  );
}

main().catch((err) => {
  console.error("エラー:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

export {};
