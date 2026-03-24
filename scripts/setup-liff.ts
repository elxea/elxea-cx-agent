/**
 * LIFF アプリ登録スクリプト。
 *
 * LINE Developers API を使って LIFF アプリを登録し、
 * 発行された LIFF ID を出力する。
 *
 * 前提:
 *   - LINE_CHANNEL_ACCESS_TOKEN が設定済み（Messaging API チャネルのアクセストークン）
 *   - LIFF_ENDPOINT_URL が設定済み（例: https://elxea-web-app.vercel.app/liff）
 *
 * 実行:
 *   LINE_CHANNEL_ACCESS_TOKEN=xxx LIFF_ENDPOINT_URL=https://... npx tsx scripts/setup-liff.ts
 *
 * 参考: https://developers.line.biz/en/reference/liff-server/#add-liff-app
 */

const LINE_API_BASE = "https://api.line.me/liff/v1";

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const endpointUrl = process.env.LIFF_ENDPOINT_URL;

if (!token) {
  console.error(
    "LINE_CHANNEL_ACCESS_TOKEN が未設定です。\n" +
      "export LINE_CHANNEL_ACCESS_TOKEN=xxxx してから実行してください。",
  );
  process.exit(1);
}

if (!endpointUrl) {
  console.error(
    "LIFF_ENDPOINT_URL が未設定です。\n" +
      "export LIFF_ENDPOINT_URL=https://your-webapp.vercel.app/liff してから実行してください。",
  );
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
};

// ------------------------------------------------------------------
// LIFF アプリ一覧を取得（既存の LIFF ID を確認）
// ------------------------------------------------------------------

async function listLiffApps(): Promise<
  Array<{ liffId: string; view: { type: string; url: string } }>
> {
  const res = await fetch(`${LINE_API_BASE}/apps`, { headers });

  if (!res.ok) {
    // 404 = LIFF アプリが0件の場合
    if (res.status === 404) {
      return [];
    }
    const body = await res.text();
    throw new Error(`LIFF list error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    apps: Array<{ liffId: string; view: { type: string; url: string } }>;
  };
  return data.apps ?? [];
}

// ------------------------------------------------------------------
// LIFF アプリを新規登録
// ------------------------------------------------------------------

async function createLiffApp(
  endpointUrl: string,
  viewType: "full" | "tall" | "compact" = "full",
): Promise<string> {
  const body = {
    view: {
      type: viewType,
      url: endpointUrl,
    },
    description: "elxea LIFF App",
    features: {
      ble: false,
      qrCode: false,
    },
    permanentLinkPattern: "replace",
    scope: ["profile", "openid"],
    botPrompt: "none",
  };

  const res = await fetch(`${LINE_API_BASE}/apps`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`LIFF create error (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as { liffId: string };
  return data.liffId;
}

// ------------------------------------------------------------------
// メイン
// ------------------------------------------------------------------

async function main() {
  console.log("LIFF アプリのセットアップを開始します...\n");

  // 既存の LIFF アプリを確認
  console.log("既存の LIFF アプリを確認中...");
  const existing = await listLiffApps();

  if (existing.length > 0) {
    console.log("既存の LIFF アプリ:");
    existing.forEach((app) => {
      console.log(`  - ${app.liffId}: ${app.view.url}`);
    });

    const match = existing.find((app) => app.view.url === endpointUrl);
    if (match) {
      console.log(`\n既存の LIFF アプリが見つかりました: ${match.liffId}`);
      console.log(`LIFF_ID=${match.liffId}`);
      console.log(
        "\n上記の LIFF_ID を elxea-agent の Cloudflare Workers Secrets に設定してください:",
      );
      console.log(`  echo "${match.liffId}" | wrangler secret put LIFF_ID`);
      return;
    }
  }

  // 新規登録
  console.log(`\nLIFF アプリを新規登録中... (endpoint: ${endpointUrl})`);
  const liffId = await createLiffApp(endpointUrl!, "full");

  console.log(`\nLIFF アプリ登録成功:`);
  console.log(`  LIFF_ID=${liffId}`);
  console.log(`  LIFF URL: https://liff.line.me/${liffId}`);
  console.log(
    "\n以下のコマンドで elxea-agent に LIFF_ID を設定してください:",
  );
  console.log(`  echo "${liffId}" | wrangler secret put LIFF_ID`);
  console.log(`  echo "${liffId}" | wrangler secret put LIFF_ID --env staging`);
  console.log(
    "\nelxea-web-app の Vercel 環境変数にも設定してください:",
  );
  console.log(`  vercel env add NEXT_PUBLIC_LIFF_ID production`);
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});

export {};
