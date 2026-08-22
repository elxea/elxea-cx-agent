/**
 * Identity Link Route -- POST /api/identity/link
 *
 * @layer CDP — CDP 所有。src/routes 配下は既定では CX（チャネルの入口）だが、この経路だけは
 *   例外で、やっていることは本人同定と会話履歴の統合＝名寄せそのもの。
 *   誤って CX 扱いにすると「文言の都合で名寄せ条件を触る」事故につながるため CDP を明示する。
 *
 * LINE Login や Shopify OAuth 後に、anonymous session を
 * identified user に統合するエンドポイント。
 *
 * Web チャットの chat-provider が LINE Login 成功後に
 * session_id を送信し、過去の anonymous 会話を統合する。
 */
import type { Context } from "hono";
import type { Env } from "../index";
import { createSupabaseClient } from "../lib/supabase";
import {
  resolveWithShopifyCustomerId,
  mergeAnonymousSession,
  linkLineByEmail,
} from "../lib/identity";
import {
  validateSessionId,
  validateShopifyCustomerId,
  validateLineMessagingUserId,
  normalizeShopifyCustomerId,
} from "../lib/web-auth";
import { requireSyncApiKey } from "../lib/sync-auth";
import {
  upsertCustomerLinkage,
  getLinkageStatus,
  getLinkageByLineUser,
  listLinkedLineUserIds,
  clearCustomerLinkage,
  resolveUnlinkTargets,
} from "../lib/customer-linkage";
import {
  issueAccountLinkNonce,
  isValidLinkTokenFormat,
  buildAccountLinkRedirectUrl,
} from "../lib/account-link";
import { getFirestoreEnv, mergeLineUserIntoShopify } from "../lib/firestore";
import { logFlowEvent } from "../lib/flow-events";

/**
 * POST /api/identity/link-line
 *
 * Auth.js signIn callback から呼ばれる。
 * LINE Login で取得した line_user_id（実際は LINE Login userId）を
 * user_identity_map の line_login_user_id カラムに登録する。
 *
 * 注意: リクエストの `line_user_id` フィールド名は後方互換のため維持するが、
 * 内部では line_login_user_id として保存する（Messaging API userId とは異なる）。
 *
 * session_id が提供された場合、anonymous session の会話データを
 * identified user に統合する（mergeAnonymousSession）。
 *
 * Shopify Customer が同じメールで存在する場合は自動紐付け。
 *
 * リクエストボディ:
 * {
 *   line_user_id: string,        // 必須（LINE Login userId）
 *   email?: string | null,       // LINE に登録されたメール
 *   display_name?: string | null // LINE の表示名
 *   session_id?: string | null   // Web チャットの session_id（cookie から取得）
 * }
 */
export async function identityLinkLineHandler(c: Context<{ Bindings: Env }>) {
  // C1: Verify shared secret (SYNC_API_SECRET) via X-API-Key header（fail-closed）
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  let body: {
    line_user_id?: string;
    email?: string | null;
    display_name?: string | null;
    session_id?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { line_user_id, email, display_name, session_id } = body;

  if (!line_user_id || typeof line_user_id !== "string") {
    return c.json({ error: "line_user_id is required" }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  try {
    // line_user_id は LINE Login userId なので、linkLineByEmail に渡す
    // （linkLineByEmail 内部で line_login_user_id カラムに保存される）
    const result = await linkLineByEmail(
      supabase,
      line_user_id,
      email ?? null,
      display_name ?? null,
    );

    // If session_id is provided, merge anonymous session conversations
    let mergedCount = 0;
    if (session_id && typeof session_id === "string") {
      console.log(
        `[identity/link-line] Merging anonymous session ${session_id} to unified user ${result.unifiedUserId}`,
      );
      const mergeResult = await mergeAnonymousSession(
        supabase,
        session_id,
        result.unifiedUserId,
      );
      mergedCount = mergeResult.mergedCount;
    }

    return c.json({
      success: true,
      unified_user_id: result.unifiedUserId,
      action: result.action,
      merged_count: mergedCount,
    });
  } catch (err) {
    console.error("[identity/link-line] error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/identity/link
 *
 * リクエストボディ:
 * {
 *   session_id: string,           // 現在の Web セッション ID
 *   shopify_customer_id: string,  // Shopify Customer GID or ID
 *   line_user_id?: string,        // LINE Login で取得した LINE userId（任意）
 * }
 *
 * レスポンス:
 * {
 *   success: true,
 *   unified_user_id: string,
 *   merged_count: number,         // 統合された会話数
 *   is_linked: boolean,           // LINE とも紐付けされているか
 * }
 */
export async function identityLinkHandler(c: Context<{ Bindings: Env }>) {
  // C: Verify shared secret (SYNC_API_SECRET) via X-API-Key header（fail-closed）。
  // link-line と同じ認証を要求し、無認証での identity 束縛（なりすまし）を塞ぐ。
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  let body: {
    session_id?: string;
    shopify_customer_id?: string;
    line_user_id?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { session_id, shopify_customer_id, line_user_id } = body;

  // session_id バリデーション
  const sessionError = validateSessionId(session_id);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  // shopify_customer_id バリデーション（必須）
  if (!shopify_customer_id) {
    return c.json({ error: "shopify_customer_id is required" }, 400);
  }
  const shopifyError = validateShopifyCustomerId(shopify_customer_id);
  if (shopifyError) {
    return c.json({ error: shopifyError }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  const sessionId = session_id as string;

  try {
    // 1. Shopify Customer ID で Identity を解決（自動登録含む）
    const identity = await resolveWithShopifyCustomerId(
      supabase,
      shopify_customer_id,
      sessionId,
    );

    // 2. LINE userId が提供された場合、user_identity_map に追記
    if (line_user_id) {
      const { error: lineError } = await supabase
        .from("user_identity_map")
        .update({ line_user_id })
        .eq("unified_user_id", identity.unifiedUserId);

      if (lineError) {
        console.warn("[identity/link] Failed to link LINE userId:", lineError.message);
      } else {
        console.log(
          `[identity/link] Linked LINE user ${line_user_id} to unified user ${identity.unifiedUserId}`,
        );
      }
    }

    // 3. anonymous session の会話データを統合
    const { mergedCount } = await mergeAnonymousSession(
      supabase,
      sessionId,
      identity.unifiedUserId,
    );

    return c.json({
      success: true,
      unified_user_id: identity.unifiedUserId,
      merged_count: mergedCount,
      is_linked: identity.isLinked || !!line_user_id,
    });
  } catch (err) {
    console.error("[identity/link] error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * 連携成立時の好み引き継ぎ（lineUsers→users カルテ統合）を安全に実行する（never throw）。
 *
 * 設計 §3 引き継ぎ / ジャーニー S5「会員とつながったら好みが引き継がれた」の成立点。
 * Firestore 未設定・失敗は握り潰す（連携応答 200 を落とさない・会話/連携を止めない）。data-only。
 * 冪等・graceful は mergeLineUserIntoShopify 側が担保する（本ラッパは非致命化だけを足す）。
 */
async function runCarryoverMerge(
  env: Env,
  lineUserId: string,
  shopifyCustomerId: string,
): Promise<void> {
  try {
    const fsEnv = getFirestoreEnv(env);
    await mergeLineUserIntoShopify(lineUserId, shopifyCustomerId, fsEnv);
  } catch (err) {
    // Firestore 未設定（GA 前は creds 無しでここに来る）や一時失敗は非致命。連携自体は成立済み。
    console.warn(
      "[identity/link-liff] karte carryover merge skipped/failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * POST /api/identity/link-liff
 *
 * 案A（LIFF 連携）第1弾の中心。LINE Bot ランタイムが読む Supabase `customer_linkages`
 * に「トーク用（Messaging）userId ↔ Shopify 顧客」の 1 行を冪等に作る、これまで存在しなかった
 * 書き込み経路。既存の identity/link（user_identity_map への書き込み）は一切変更しない
 * （別テーブル・別ハンドラ）。
 *
 * 認証（server-to-server・SYNC_API_SECRET 維持）:
 *   このエンドポイントは web-app の route handler（サーバ）から X-API-Key 付きで呼ばれる。
 *   ブラウザから直叩きさせない（SYNC_API_SECRET をブラウザに置かない）。fail-closed。
 *
 * なりすまし不能性（設計の要点）:
 *   1. line_messaging_user_id は web-app が「LINE 署名済み LIFF id_token」を LINE の verify API で
 *      検証して取り出した `sub`。ブラウザは sub を詐称できない（LINE の署名鍵が要る）。
 *   2. shopify_customer_id は web-app のサーバ認証済み Shopify セッション（requireAuth）由来。
 *      ブラウザ自己申告の customer_id は使わない（他人の顧客IDで連携する穴を塞ぐ）。
 *   3. 本エンドポイントは X-API-Key（SYNC_API_SECRET）でゲートし、web-app サーバ以外から
 *      呼べないようにする。
 *   → 形式ゲート（下記バリデータ）は多層防御の 1 枚目に過ぎず、真正性の本体は上記 1–3。
 *
 * リクエストボディ:
 * {
 *   line_messaging_user_id: string,   // 必須。`U` + 32 hex（Messaging userId）
 *   shopify_customer_id: string,      // 必須。GID or 数値。内部で数値へ正規化
 *   shopify_email?: string | null,    // 任意。分かれば保存
 * }
 *
 * レスポンス:
 * { success: true, line_user_id: string, shopify_customer_id: string }
 */
export async function identityLinkLiffHandler(c: Context<{ Bindings: Env }>) {
  // C: server-to-server 認証（SYNC_API_SECRET）。fail-closed。ブラウザ直叩き不可。
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  let body: {
    line_messaging_user_id?: string;
    shopify_customer_id?: string;
    shopify_email?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { line_messaging_user_id, shopify_customer_id, shopify_email } = body;

  // line_messaging_user_id バリデーション（Messaging userId 形式）
  const lineError = validateLineMessagingUserId(line_messaging_user_id);
  if (lineError) {
    return c.json({ error: lineError }, 400);
  }

  // shopify_customer_id を数値へ正規化（GID / 数値のどちらでも受ける）
  const normalized = normalizeShopifyCustomerId(shopify_customer_id);
  if ("error" in normalized) {
    return c.json({ error: normalized.error }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  try {
    const result = await upsertCustomerLinkage(supabase, {
      lineUserId: line_messaging_user_id as string,
      shopifyCustomerId: normalized.numericId,
      shopifyEmail: shopify_email ?? null,
      // 発生源（migration 026）: この経路の連携は必ず LIFF 由来。
      source: "liff",
    });

    if (!result.ok) {
      // 世帯共有/付け替え（N:1）で shopify_customer_id の UNIQUE と衝突した場合は 500 でなく 409。
      //   staging は migration 027 で UNIQUE を緩めるためこの経路には入らない。prod は 027 未適用の間の
      //   fail-safe（別の LINE が同じ Shopify 顧客に連携しようとしたときに 500 を返さない）。
      if (result.conflict === "shopify_customer_id") {
        console.warn(
          "[identity/link-liff] shopify_customer_id already linked (N:1 blocked by pre-027 UNIQUE):",
          result.error,
        );
        return c.json({ error: "shopify_customer_already_linked" }, 409);
      }
      console.error("[identity/link-liff] upsert failed:", result.error);
      return c.json({ error: "Failed to persist linkage" }, 500);
    }

    console.log(
      `[identity/link-liff] linked messaging user ${result.lineUserId} <-> shopify ${result.shopifyCustomerId}`,
    );

    // QA S-1: 連携成立時に未連携カルテ（lineUsers）の好みを users へ累積統合する（冪等・best-effort）。
    //   併せて「連携先に注文/定期便があるか」を判定し、web-app の完了画面コピー分岐（CX S2）に渡す。
    //   Firestore 未設定・失敗でも連携は成立済み（200）を返す。過大約束を避けるため既定は false。
    let hasPurchaseActivity = false;
    try {
      const fsEnv = getFirestoreEnv(c.env);
      const mergeTask = (async () => {
        const merged = await mergeLineUserIntoShopify(
          result.lineUserId,
          result.shopifyCustomerId,
          fsEnv,
        );
        return (
          merged?.isSubscriber === true ||
          (merged?.lastPurchaseAt != null && merged.lastPurchaseAt !== "")
        );
      })();
      // 応答を遅らせないよう merge/判定は待つが、失敗しても連携成立は保つ。
      hasPurchaseActivity = await mergeTask;
    } catch (err) {
      console.warn(
        "[identity/link-liff] preference merge / activity check skipped:",
        err instanceof Error ? err.message : err,
      );
    }

    // 連携完了を flow_events に記録（売上重大1対応・link.completed / metadata.source=liff）。
    //   fire-and-forget。logFlowEvent は決して throw しない。応答（200）を遅らせないため
    //   executionCtx があれば waitUntil に載せ、無い環境（テスト等）では即 await に倒す。
    const linkCompletedLog = logFlowEvent(supabase, {
      eventName: "link.completed",
      userRef: result.lineUserId,
      metadata: { source: "liff" },
    });

    // 好み引き継ぎ（carryover・設計 §3 / ジャーニー S5「引き継がれた」）: 連携成立の瞬間に、未連携
    //   カルテ lineUsers/{lineUserId} の persona/tasteProfile を users/{shopifyCustomerId} へ
    //   mergePersonaScores 流儀で統合する（data-only・Firestore のみ・冪等・graceful）。
    //   非致命ラッパ runCarryoverMerge 経由（never throw）。GA 前は Firestore 未設定で no-op に倒れる。
    const carryoverMerge = runCarryoverMerge(
      c.env,
      result.lineUserId,
      result.shopifyCustomerId,
    );

    try {
      c.executionCtx.waitUntil(linkCompletedLog);
      c.executionCtx.waitUntil(carryoverMerge);
    } catch {
      await linkCompletedLog;
      await carryoverMerge;
    }

    return c.json({
      success: true,
      line_user_id: result.lineUserId,
      shopify_customer_id: result.shopifyCustomerId,
      // 連携先に注文/定期便があるか（web-app 完了画面の過大約束回避に使う・CX S2）。
      has_purchase_activity: hasPurchaseActivity,
    });
  } catch (err) {
    console.error("[identity/link-liff] error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/identity/linkage-status?shopify_customer_id=... | ?line_user_id=...
 *
 * P1（マイページに LINE 連携状態を表示）の読み取り口。customer_linkages はこれまで
 * 書き込み専用（link-liff / account-link / clear）で、**Web から状態を読む経路が無かった**。
 * そのため連携が成立してもマイページは何も変わらず「連携できたのか分からない」まま置かれていた。
 *
 * 認証（link-liff / account-link-nonce と同一方式・fail-closed）:
 *   X-API-Key（SYNC_API_SECRET）必須。**ブラウザから直叩きさせない**。
 *   これを緩めると「顧客 ID を総当たりして誰が LINE 連携しているかを外部から列挙できる」
 *   会員の在籍情報の漏洩経路になる（GET は副作用が無いぶん見落とされやすいので明記する）。
 *
 * 顧客 ID の出どころ（このハンドラの外にある前提・link-liff と同じ約束）:
 *   shopify_customer_id は web-app が **サーバ認証済み Shopify セッション（requireAuth）** から
 *   確定した値であること。ブラウザ自己申告の customer_id を web-app が転送してはならない
 *   （転送すると他人の連携状態を覗ける）。cx-agent 側では検証できないため web-app 側の責務。
 *
 * 返す情報（QA 要件 3・最小開示）:
 *   連携の有無 + 最小メタ（いつからか・件数）だけ。**line_user_id の生値は返さない**。
 *   getLinkageStatus が select を linked_at のみに絞っており、戻り値の型にも生 ID が無い。
 *
 * ## 逆引き（line_user_id 指定）— 本人解決の分裂を塞ぐために追加した第 2 の引き方
 *
 * `?line_user_id=U...` を渡すと **その LINE が連携している Shopify 顧客**を返す。
 * web-app の `resolveIdentity` は LINE セッションのとき `users/line:{lineUserId}` という
 * 別の棚に解決し、連携台帳を一切見ていなかった。そのため「連携済みなのに、メールで
 * ログインしたときと LINE でログインしたときで別のマイページが見える」（分裂の根因）。
 * 逆引きはその解決に使う読み取り口で、**新しい台帳は作らず customer_linkages を逆から引く**。
 *
 * ⚠ 開示方針が順引きと非対称なことの理由:
 *   順引きは line_user_id を返さない（Web 側が知る必要の無い他人の生 ID を渡さない）。
 *   逆引きは逆に shopify_customer_id を返す。呼び出し側は「自分がサーバ検証済みで
 *   持っている LINE userId」の持ち主が誰の棚を見るべきかを知る必要があり、これを
 *   返さないと本人解決そのものが成立しないため。信頼境界は順引きと同一
 *   （X-API-Key を持つサーバのみ・ブラウザ直叩き不可）で、新たな露出面は増えない。
 *   前提（このハンドラの外）: line_user_id は web-app が **サーバ側で検証済み**の値
 *   （id_token の sub / 暗号化 cookie の復号結果）であること。ブラウザ自己申告を転送しない。
 *
 * 排他: shopify_customer_id と line_user_id は **どちらか一方だけ**を指定する。
 *   両方 / どちらも無しは 400（どちらを見たのか曖昧なまま「未連携」を返さない）。
 *
 * スコープ:
 *   状態の**読み取り**だけ。解除は別ハンドラ（`identityUnlinkHandler`）。
 *
 * レスポンス:
 *   順引き: { linked: boolean, linkedAt: string | null, count: number }
 *   逆引き: { linked: boolean, linkedAt: string | null, count: number,
 *             shopify_customer_id: string | null }
 */
export async function identityLinkageStatusHandler(
  c: Context<{ Bindings: Env }>,
) {
  // C: server-to-server 認証（SYNC_API_SECRET）。fail-closed。ブラウザ直叩き不可。
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  const rawShopifyCustomerId = c.req.query("shopify_customer_id");
  const rawLineUserId = c.req.query("line_user_id");

  const hasShopify = typeof rawShopifyCustomerId === "string" && rawShopifyCustomerId !== "";
  const hasLine = typeof rawLineUserId === "string" && rawLineUserId !== "";

  if (hasShopify && hasLine) {
    return c.json(
      { error: "Specify either shopify_customer_id or line_user_id, not both" },
      400,
    );
  }

  const supabase = createSupabaseClient(c.env);

  // --- 逆引き: LINE userId → Shopify 顧客（本人解決） ---
  if (hasLine) {
    const invalid = validateLineMessagingUserId(rawLineUserId as string);
    if (invalid) return c.json({ error: invalid }, 400);

    const reverse = await getLinkageByLineUser(supabase, rawLineUserId as string);
    if (!reverse.ok) {
      console.error("[identity/linkage-status] reverse query failed:", reverse.error);
      return c.json({ error: "Failed to read linkage status" }, 500);
    }

    return c.json({
      linked: reverse.linkage.linked,
      linkedAt: reverse.linkage.linkedAt,
      count: reverse.linkage.count,
      shopify_customer_id: reverse.linkage.shopifyCustomerId,
    });
  }

  // --- 順引き: Shopify 顧客 → 連携の有無（従来どおり） ---
  // shopify_customer_id を数値へ正規化（GID / 数値のどちらでも受ける）
  const normalized = normalizeShopifyCustomerId(rawShopifyCustomerId);
  if ("error" in normalized) {
    return c.json({ error: normalized.error }, 400);
  }

  const result = await getLinkageStatus(supabase, normalized.numericId);
  if (!result.ok) {
    console.error("[identity/linkage-status] query failed:", result.error);
    return c.json({ error: "Failed to read linkage status" }, 500);
  }

  return c.json({
    linked: result.status.linked,
    linkedAt: result.status.linkedAt,
    count: result.status.count,
  });
}

/**
 * POST /api/identity/unlink
 *
 * Web（マイページ）からの連携解除。**解除ロジックは新規に起こさず、既存の
 * `clearCustomerLinkage`（`src/lib/customer-linkage.ts`）への HTTP 入口を足すだけ**。
 * 別実装を起こすと「解除とは何か」の定義が 2 つに割れる。
 *
 * ## なぜ必要か（これが無いと解除が嘘になる）
 *   これまで解除は 2 系統に割れていた。
 *   - web-app `DELETE /api/user/line-link` … Firestore の `lineUserId` を消すだけで、
 *     Bot ランタイムが読む `customer_linkages` には触れない。**消えていないのに 200 を返す**。
 *   - cx-agent `clearCustomerLinkage` … 実体はあるが HTTP 入口が無く、LINE トークの
 *     完全一致キーワードからしか到達できない。
 *   本ハンドラが後者に入口を与え、web-app の DELETE がここを呼んでから Firestore を消す
 *   （順序が逆だと、cx が失敗したときに Firestore だけ消えて状態が割れる）。
 *
 * ## verb が POST である理由（DELETE ではない）
 *   このリポジトリに `app.delete` は 1 本も無く、CORS の `allowMethods` にも DELETE が
 *   入っていない（`src/index.ts` の cors 設定）。既存の流儀に合わせて POST にする。
 *
 * 認証（link-liff / linkage-status と同一方式・fail-closed）:
 *   X-API-Key（SYNC_API_SECRET）必須。**ブラウザから直叩きさせない**。
 *   無認証にすると任意の顧客の連携を外せる（サービス妨害 + 配信の一斉停止）。
 *
 * なりすまし不能性の分担（このハンドラの外にある前提・link-liff と同じ約束）:
 *   shopify_customer_id は web-app が **サーバ認証済み Shopify セッション（requireAuth）**
 *   から確定した値であること。ブラウザ自己申告の customer_id を転送してはならない。
 *
 * ## N:1（世帯共有）の扱い
 *   1 顧客に複数の LINE が紐づきうる（migration 027）。
 *   - `line_user_id` 省略 … その顧客の**有効な連携をすべて**解除する。
 *   - `line_user_id` 指定 … その 1 件だけ解除する。ただし **指定 ID がその顧客に
 *     紐づいていることを先に確認**する（確認しないと、他人の LINE の連携を
 *     自分の顧客 ID で外せてしまう）。紐づいていなければ 403。
 *
 * ## 行は消さない（罠 G-23）
 *   `clearCustomerLinkage` は連携 3 列を null にするだけで行を削除しない。同じ行に
 *   `broadcast_opted_out` / `unfollowed_at` が同居しており、行ごと消すとお客さまが
 *   設定した配信停止が巻き戻る。
 *
 * 冪等: 元から未連携でも 200（`cleared_count: 0`）。二度押し・再送で壊れない。
 *
 * リクエストボディ:
 * {
 *   shopify_customer_id: string,  // 必須。GID or 数値。内部で数値へ正規化
 *   line_user_id?: string,        // 任意。N:1 のとき解除対象を 1 件に絞る
 * }
 *
 * レスポンス:
 * { success: true, cleared_count: number, remaining_count: number }
 *
 * ⚠ 応答に LINE の生 ID を載せない（件数だけ）。
 */
export async function identityUnlinkHandler(c: Context<{ Bindings: Env }>) {
  // C: server-to-server 認証（SYNC_API_SECRET）。fail-closed。ブラウザ直叩き不可。
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  let body: {
    shopify_customer_id?: string;
    line_user_id?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const normalized = normalizeShopifyCustomerId(body.shopify_customer_id);
  if ("error" in normalized) {
    return c.json({ error: normalized.error }, 400);
  }

  const targetLineUserId = body.line_user_id;
  if (targetLineUserId !== undefined) {
    const invalid = validateLineMessagingUserId(targetLineUserId);
    if (invalid) return c.json({ error: invalid }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  // 解除対象の決定。ここで引いた生 ID は cx-agent の中だけで使う（応答に載せない）。
  const listed = await listLinkedLineUserIds(supabase, normalized.numericId);
  if (!listed.ok) {
    console.error("[identity/unlink] lookup failed:", listed.error);
    return c.json({ error: "Failed to resolve linkages" }, 500);
  }

  // 所有権の確認を含む対象決定（純関数。指定 ID がこの顧客に紐づいていなければ外させない）。
  const decided = resolveUnlinkTargets(listed.lineUserIds, targetLineUserId);
  if (!decided.ok) {
    return c.json({ error: decided.error }, 403);
  }
  const targets = decided.targets;

  let clearedCount = 0;
  for (const lineUserId of targets) {
    const result = await clearCustomerLinkage(supabase, lineUserId);
    if (!result.ok) {
      // 一部成功のまま「成功」を返さない。どこまで消えたかを添えて 500 にする
      // （成功偽装をしないのが本 PR の主旨そのもの）。
      console.error("[identity/unlink] clear failed:", result.error);
      return c.json(
        { error: "Failed to clear linkage", cleared_count: clearedCount },
        500,
      );
    }
    if (result.cleared) clearedCount++;
  }

  const remainingCount = Math.max(listed.lineUserIds.length - targets.length, 0);

  console.log(
    `[identity/unlink] cleared=${clearedCount} requested=${targets.length} remaining=${remainingCount}`,
  );

  return c.json({
    success: true,
    cleared_count: clearedCount,
    remaining_count: remainingCount,
  });
}

/**
 * POST /api/identity/account-link-nonce
 *
 * LINE 純正 Account Link の 3〜4 手目（自社ユーザー確定 → nonce 発行 → 連携ダイアログへ）。
 * web-app の /{locale}/link から **サーバ間**で呼ばれる。
 *
 * 認証（link-liff と同一方式・fail-closed）:
 *   X-API-Key（SYNC_API_SECRET）必須。ブラウザから直叩きさせない。
 *   これを緩めると「他人の shopify_customer_id を送って nonce を貰う」＝連携の乗っ取りが成立する。
 *
 * なりすまし不能性の分担（このハンドラの外にある前提）:
 *   shopify_customer_id は web-app が **サーバ認証済み Shopify セッション（requireAuth）** から
 *   確定した値であること。ブラウザ自己申告の customer_id を web-app が転送してはならない
 *   （link-liff の設計コメントと同じ約束。cx-agent 側では検証できないため web-app 側の責務）。
 *
 * リクエストボディ:
 * {
 *   shopify_customer_id: string,  // 必須。GID or 数値。内部で数値へ正規化
 *   link_token?: string,          // 任意。あればリダイレクト先 URL まで組んで返す
 * }
 *
 * レスポンス:
 * { success: true, nonce: string, expires_at: string, redirect_url?: string }
 *
 * ⚠ nonce / link_token の値はログに出さない（漏れると連携を横取りできる）。
 */
export async function identityAccountLinkNonceHandler(
  c: Context<{ Bindings: Env }>,
) {
  // C: server-to-server 認証（SYNC_API_SECRET）。fail-closed。ブラウザ直叩き不可。
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  let body: {
    shopify_customer_id?: string;
    link_token?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { shopify_customer_id, link_token } = body;

  // shopify_customer_id を数値へ正規化（GID / 数値のどちらでも受ける）
  const normalized = normalizeShopifyCustomerId(shopify_customer_id);
  if ("error" in normalized) {
    return c.json({ error: normalized.error }, 400);
  }

  // link_token は任意。渡すなら形式ゲートを通す（URL に載せる前のゴミ・過大長を弾く）。
  if (link_token !== undefined && !isValidLinkTokenFormat(link_token)) {
    return c.json({ error: "Invalid link_token" }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  try {
    const issued = await issueAccountLinkNonce(
      supabase,
      normalized.numericId,
    );
    if (!issued.ok) {
      console.error("[identity/account-link-nonce] nonce issue failed:", issued.reason);
      return c.json({ error: "Failed to issue nonce" }, 500);
    }

    // 値そのものは出さない（顧客 ID だけで足跡は追える）。
    console.log(
      `[identity/account-link-nonce] issued nonce for shopify ${normalized.numericId}`,
    );

    return c.json({
      success: true,
      nonce: issued.nonce,
      expires_at: issued.expiresAt,
      ...(link_token
        ? { redirect_url: buildAccountLinkRedirectUrl(link_token, issued.nonce) }
        : {}),
    });
  } catch (err) {
    console.error("[identity/account-link-nonce] error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}
