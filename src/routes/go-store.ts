/**
 * 転送口 GET /go/store — LINE 仮メニュー ③「Amazonストア」の押下を 1 件記録してから、購入先へ 302 で送る (D4)。
 *
 * 正本:
 *   - 実装設計 rev2 第7章「D4 転送口 /go/store と記録 (Workers Analytics Engine)」/ 第9章 テスト7
 *     https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *   - 設計 QA (3 回目の軽微 m5: クエリは無視して固定先へ転送 / 外のブラウザで開くと区分はほぼ other)
 *     https://app.notion.com/p/3e770c9d064c81cca15dcec451445605
 *
 * 決まりごと:
 *   - 行き先は storefront.ts の PURCHASE_URL に **固定**。クエリ・パス・ヘッダでは変えられない
 *     (開いた転送口 = open redirect にしない)。閉店中は Amazon の elxea ストア、開店後は公式 EC。
 *   - GET だけ記録する。HEAD は 302 を返すが記録しない (リンクの下見で数が膨らまないように)。
 *     GET・HEAD 以外は 405。
 *   - 記録は Workers Analytics Engine (binding `STORE_TAP_EVENTS`)。本番のデータベースには書かない
 *     (migration なし)。writeDataPoint は待たずに返る (公式:「You do not need to await writeDataPoint()」)
 *     ので転送を遅らせない。記録先が無い・例外を投げたときも、転送は必ず 302 で成功させる。
 *   - 記録するのは「押された 1 回」と User-Agent の区分だけ。User-Agent そのもの・IP・識別子は記録しない。
 *     数えられるのは押された回数で、人数ではない (uri アクションは誰が押したかを持たない)。
 *   - bot は書き込み時に落とさず区分 `bot` で記録し、集計のときに除く (後から基準を変えられる)。
 *     回数は Analytics Engine の SQL で `SUM(_sample_interval)` として数える (サンプリング補正)。
 *
 * この口は顧客データに触れないので、src/index.ts の Firestore 起動ゲートより前に登録し、
 * ゲートの除外リストにも入れてある (設定の不備で「押したのに開かない」を起こさないため)。
 */
import type { Context } from "hono";
import type { Env } from "../index";
import { PURCHASE_URL } from "../lib/storefront";

/** 転送口のパス。メニュー定義 (D3) の ③ の uri は「チャネルごとの Worker の住所 + このパス」。 */
export const GO_STORE_PATH = "/go/store";

/** Analytics Engine の index (集計の切り口)。設計第7章の `indexes: ["go_store"]`。 */
export const GO_STORE_INDEX = "go_store";

/** blobs の 1 つ目 (出来事の種類)。 */
export const GO_STORE_EVENT = "tap";

/** 許可するメソッド (405 の Allow ヘッダにも使う)。 */
export const GO_STORE_ALLOWED_METHODS = ["GET", "HEAD"] as const;

/**
 * User-Agent の区分。
 * ③ は uri に `openExternalBrowser=1` を付けて外のブラウザで開く (D3 がメニュー定義側で付ける) ため、
 * 押下のほとんどは `other` に入り、`line_inapp` は「LINE 内ブラウザで開かれた例外」を表す区分になる。
 */
export type StoreTapUaClass = "line_inapp" | "bot" | "other";

/**
 * bot とみなす User-Agent (大文字小文字は区別しない)。LINE のリンク下見 (`line-poker`) も含む。
 * 書き込み時に落とすためではなく、集計で除くための目印。
 */
const BOT_UA_RE =
  /bot\b|crawl|spider|slurp|facebookexternalhit|line-poker|preview|headless|curl\/|wget\/|python-requests|go-http-client|node-fetch|axios\//i;

/** LINE 内ブラウザ (例: `... Safari Line/14.10.0`)。 */
const LINE_INAPP_UA_RE = /\bLine\/\d/i;

/**
 * User-Agent を 3 区分に分ける。User-Agent が無い・空はブラウザではないので `bot`。
 * bot の判定を先にする (下見の UA が LINE の文字を含んでも bot に入れる)。
 */
export function classifyUserAgent(ua: string | null | undefined): StoreTapUaClass {
  const s = (ua ?? "").trim();
  if (s === "") return "bot";
  if (BOT_UA_RE.test(s)) return "bot";
  if (LINE_INAPP_UA_RE.test(s)) return "line_inapp";
  return "other";
}

/**
 * 押下を 1 件記録する。**決して例外を投げない** (転送を止めないため)。
 * 記録できたら true、記録先が無い・失敗したら false。ログに User-Agent・本文は出さない。
 */
export function recordStoreTap(
  dataset: AnalyticsEngineDataset | undefined,
  uaClass: StoreTapUaClass,
): boolean {
  if (!dataset || typeof dataset.writeDataPoint !== "function") {
    console.warn("[go-store] record skipped: STORE_TAP_EVENTS binding is missing");
    return false;
  }
  try {
    // 待たない (writeDataPoint は void を返し、書き込みは Workers ランタイムが裏で行う)。
    dataset.writeDataPoint({
      indexes: [GO_STORE_INDEX],
      blobs: [GO_STORE_EVENT, uaClass],
      doubles: [1],
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[go-store] record failed: ${message}`);
    return false;
  }
}

/** 購入先への 302。キャッシュさせない (キャッシュされると押下が数えられなくなる)。 */
function redirectToStore(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: PURCHASE_URL,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * /go/store の本体 (Hono に依存しない形。テストはここを直接呼べる)。
 * 行き先は PURCHASE_URL 固定で、request の URL (クエリ・パス) は読まない。
 */
export function handleGoStore(request: Request, env: Pick<Env, "STORE_TAP_EVENTS">): Response {
  const method = request.method.toUpperCase();
  if (method === "HEAD") return redirectToStore();
  if (method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: { Allow: GO_STORE_ALLOWED_METHODS.join(", ") },
    });
  }
  recordStoreTap(env.STORE_TAP_EVENTS, classifyUserAgent(request.headers.get("user-agent")));
  return redirectToStore();
}

/**
 * Hono のハンドラ (src/index.ts で `app.all(GO_STORE_PATH, goStoreHandler)` として登録する)。
 * Hono は HEAD を GET のルートへ回すが、c.req.raw.method は元の "HEAD" のままなので区別できる。
 */
export function goStoreHandler(c: Context<{ Bindings: Env }>): Response {
  return handleGoStore(c.req.raw, c.env ?? {});
}
