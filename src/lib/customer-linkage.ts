/**
 * customer_linkages 連携行の upsert（案A: LIFF 連携の中心ギャップを埋める書き込み経路）。
 *
 * 背景（統合設計書 §A / 前任調査）:
 *   cx-agent には identity/link（shopify_customer_id → user_identity_map）は既にあったが、
 *   **LINE Bot ランタイムが読む Supabase `customer_linkages`（トーク用 Messaging userId ↔
 *   Shopify 顧客）に本番で行を作る経路が無かった**。これがブロック4（連携導線）の空洞。
 *   本モジュールはその 1 行 upsert を、冪等（onConflict=line_user_id）で提供する。
 *
 * 位置づけ（事実）:
 *   - 書き込むのは Supabase の customer_linkages のみ。Shopify には一切触れない。
 *   - line_user_id は「トーク用（Messaging）userId」。真正性は呼び出し側（route）が
 *     LINE 署名済み id_token の検証結果 `sub` を渡すことで担保する（本モジュールは受け取った
 *     値を素直に書くだけ・形式検証は route が web-auth のバリデータで行う）。
 *   - shopify_customer_id は数値文字列（webhook と同じ表現）。route が正規化して渡す。
 *
 * 冪等性:
 *   同じ line_user_id で複数回呼んでも 1 行（onConflict=line_user_id で更新）。
 *   これにより Bot「連携」の二度押し・再送でも安全（重複行・エラーにならない）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** 連携 upsert の入力（すべて正規化済み・route 側で検証済みの値を受ける）。 */
export type CustomerLinkageInput = {
  /** トーク用（Messaging）userId。`U` + 32 hex。id_token 検証済みの sub。 */
  lineUserId: string;
  /** Shopify 顧客 ID（数値文字列）。 */
  shopifyCustomerId: string;
  /** 任意: Shopify 登録メール（分かれば保存。不明なら省略）。 */
  shopifyEmail?: string | null;
  /**
   * 任意: 連携の発生源（migration 026 の source 列）。'liff' / 'owner_kit' / 'follow_ref' 等。
   * 指定時のみ書く（未指定は列に触れない = 既存値を消さない）。
   */
  source?: string | null;
};

/** 連携 upsert の結果。 */
export type CustomerLinkageResult =
  | { ok: true; lineUserId: string; shopifyCustomerId: string }
  | {
      ok: false;
      error: string;
      /**
       * 失敗が「shopify_customer_id の UNIQUE 制約（migration 002）と衝突」だった場合の識別子（QA M-1）。
       * 世帯共有/付け替え（複数 LINE → 1 Shopify 顧客 = N:1）を staging では migration 027 で許可するが、
       * 027 未適用の環境（prod 過渡期）ではここに入り、呼び出し側は 500 でなく 409 に倒す。
       */
      conflict?: "shopify_customer_id";
    };

/** Messaging userId 形式（U + 32 hex）。upsert 前の防御的検証に使う（QA S-2・別プロバイダ罠の一次防波堤）。 */
const MESSAGING_USER_ID_RE = /^U[0-9a-f]{32}$/;

/**
 * shopify_customer_id の UNIQUE 制約違反（N:1 を阻む衝突）か（QA M-1）。
 * Postgres 23505 = unique_violation。制約名 `customer_linkages_shopify_customer_id_key`
 * または列名 shopify_customer_id を含むメッセージで判定する（onConflict=line_user_id では吸収されない衝突）。
 */
function isShopifyCustomerIdConflict(error: {
  code?: string;
  message?: string;
  details?: string;
}): boolean {
  if ((error.code ?? "") !== "23505") return false;
  const hay = `${error.message ?? ""} ${error.details ?? ""}`;
  return (
    /shopify_customer_id/i.test(hay) ||
    /customer_linkages_shopify_customer_id_key/i.test(hay)
  );
}

/**
 * customer_linkages に 1 行 upsert する（冪等・onConflict=line_user_id）。
 *
 * - shopify_customer_id は指定した値で更新する（連携先の付け替えも同一 line_user_id で吸収）。
 * - broadcast_opted_out / unfollowed_at 等の既存フラグ列には触れない（連携の再実行で
 *   配信除外状態を巻き戻さない）。
 * - linked_at / updated_at を now で更新する（既存 broadcast-optout / test-linkage-kit と同じ列運用）。
 *
 * ロールバック安全（expand/contract）: source 列（migration 026）が未適用の環境でも、連携そのものは
 *   壊さない。source 列不在エラー（PostgREST PGRST204 / Postgres 42703）を検知したら source を落として
 *   1 度だけ再試行する。これにより「コード先行デプロイ → DDL 後追い」の順序でも 500 にならない
 *   （本番は deploy-runbook 手順1で migration を先に適用するため常に列あり。staging 過渡期の保険）。
 *
 * @returns ok:true なら成功。ok:false なら Supabase エラー理由。
 */
/** source 列が未適用（未存在）を示す PostgREST/Postgres エラーか。 */
function isMissingSourceColumnError(error: {
  code?: string;
  message?: string;
}): boolean {
  const code = error.code ?? "";
  const msg = error.message ?? "";
  // PGRST204 = schema cache に列が無い / 42703 = column does not exist。
  if (code === "PGRST204" || code === "42703") return /source/i.test(msg) || msg.length === 0;
  return /['"]?source['"]? column/i.test(msg) || /column .*source.* does not exist/i.test(msg);
}

export async function upsertCustomerLinkage(
  supabase: SupabaseClient,
  input: CustomerLinkageInput,
): Promise<CustomerLinkageResult> {
  // QA S-2（別プロバイダ罠）の防御ログ: line_user_id は本来「トーク用(Messaging) id_token の sub」。
  //   Login チャネルと Messaging チャネルが別プロバイダだと sub が Messaging userId と一致せず、
  //   連携は成功表示でも Bot が永久に未連携扱いになる（サイレント全損）。形式が Messaging userId で
  //   なければ強く警告する（route 側の validateLineMessagingUserId を通っていれば通常は発火しない多層防御）。
  if (!MESSAGING_USER_ID_RE.test(input.lineUserId)) {
    console.warn(
      "[customer-linkage] line_user_id が Messaging userId 形式(U+32hex)でない — 別プロバイダ/取り違えの疑い:",
      input.lineUserId.slice(0, 4) + "…",
    );
  }

  const nowIso = new Date().toISOString();

  const baseRow: Record<string, unknown> = {
    line_user_id: input.lineUserId,
    shopify_customer_id: input.shopifyCustomerId,
    linked_at: nowIso,
    updated_at: nowIso,
  };
  // email は分かるときだけ書く（null で既存値を消さない）。
  if (input.shopifyEmail) {
    baseRow.shopify_email = input.shopifyEmail;
  }

  // source（発生源）は指定時だけ書く（未指定で既存の source を null で消さない）。
  const row = input.source ? { ...baseRow, source: input.source } : baseRow;

  const { error } = await supabase
    .from("customer_linkages")
    .upsert(row, { onConflict: "line_user_id" });

  if (error) {
    // source 列未適用のときだけ、source を落として 1 度再試行（連携本体は成立させる）。
    if (input.source && isMissingSourceColumnError(error)) {
      console.warn(
        "[customer-linkage] source column missing (migration 026 未適用?) — source を落として再試行:",
        error.message,
      );
      const { error: retryError } = await supabase
        .from("customer_linkages")
        .upsert(baseRow, { onConflict: "line_user_id" });
      if (retryError) {
        if (isShopifyCustomerIdConflict(retryError)) {
          return { ok: false, error: retryError.message, conflict: "shopify_customer_id" };
        }
        return { ok: false, error: retryError.message };
      }
      return {
        ok: true,
        lineUserId: input.lineUserId,
        shopifyCustomerId: input.shopifyCustomerId,
      };
    }
    // 世帯共有/付け替え（N:1）が shopify_customer_id の UNIQUE と衝突（QA M-1）。500 でなく 409 に倒すため識別する。
    if (isShopifyCustomerIdConflict(error)) {
      return { ok: false, error: error.message, conflict: "shopify_customer_id" };
    }
    return { ok: false, error: error.message };
  }

  return {
    ok: true,
    lineUserId: input.lineUserId,
    shopifyCustomerId: input.shopifyCustomerId,
  };
}

/** 連携解除の結果。 */
export type ClearLinkageResult =
  | { ok: true; cleared: boolean }
  | { ok: false; error: string };

/**
 * 連携を解除する（LINE のアカウント連携の必須義務「いつでも解除できる」の実体）。
 *
 * ⚠ 行は削除しない（DELETE しない）。customer_linkages の同じ行には
 *   `broadcast_opted_out`（配信停止フラグ・migration 020）と `unfollowed_at`（除外・migration 020）が
 *   同居しており、行ごと消すと **お客さまが設定した配信停止まで巻き戻る**（再び配信対象に戻る）。
 *   よって連携に関する列だけを空にする:
 *     - shopify_customer_id → null（= 未連携。resolveCallerShopifyCustomerId が null を返す状態）
 *     - shopify_email       → null（連携由来の個人情報を残さない）
 *     - source              → null（現在の連携が無いので発生源も無い）
 *
 * 冪等: 連携が無い行・行そのものが無い場合も成功扱い（cleared=false）。二度押しで壊れない。
 * never throw（呼び出し側の会話を止めない）。
 *
 * @returns ok:true / cleared=true なら実際に連携を解除した。cleared=false は元から未連携。
 */
export async function clearCustomerLinkage(
  supabase: SupabaseClient,
  lineUserId: string,
): Promise<ClearLinkageResult> {
  if (!lineUserId) return { ok: false, error: "lineUserId is required" };

  try {
    const { data, error } = await supabase
      .from("customer_linkages")
      .update({
        shopify_customer_id: null,
        shopify_email: null,
        source: null,
        updated_at: new Date().toISOString(),
      })
      .eq("line_user_id", lineUserId)
      // 既に未連携（null）の行は更新しない → cleared=false で「元から未連携」を区別できる。
      .not("shopify_customer_id", "is", null)
      .select("line_user_id");

    if (error) return { ok: false, error: error.message };

    const rows = (data ?? []) as unknown[];
    return { ok: true, cleared: rows.length > 0 };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ---------------------------------------------------------------------------
 * 連携可否と配信可否は別の問い（2026-08-22 / P4）
 * -------------------------------------------------------------------------
 *
 * この 2 つを 1 つの条件に混ぜていたのが P4 の欠陥だった。
 *
 *   - **連携可否** … この LINE とこの顧客は結び付いているか。
 *     決めるのは `shopify_customer_id IS NOT NULL` **だけ**。
 *   - **配信可否** … いまこの LINE にメッセージを送れるか。
 *     決めるのは `unfollowed_at`（友だち解除・ブロック）と `broadcast_opted_out`（配信停止）。
 *
 * 以前は連携の判定にも `unfollowed_at IS NULL` を入れていたため、
 * **お客さまが LINE 公式アカウントをブロックしただけで連携が消えた扱い**になった。
 * その結果 web-app の逆引き（`resolveIdentity`）が「未連携」を受け取り、
 * ログイン中の人格が `line:` の空の棚に落ちて、お気に入りも行動ログも見えなくなる。
 * ブロックは「もう送らないで」という配信の意思表示であって、
 * 「この人は私ではありません」という連携の取り消しではない。解除は解除の操作
 * （`clearCustomerLinkage`）でしか起きない。
 *
 * 配信側は元から別条件で絞っている（`delivery-runtime.ts` が `unfollowed_at` /
 * `broadcast_opted_out` を読み、`target-resolver.ts` が除外する）ので、
 * ここで連携条件を緩めても **ブロック中の人に送ってしまうことはない**。
 *
 * 読み取り結果には `unfollowed` を添えて返す。連携はあるが届かない、という状態を
 * 呼び出し側が言葉にできるようにするため（連携の有無に混ぜない）。
 */

/**
 * 連携状態（読み取り側の戻り値）。
 *
 * ⚠ line_user_id を **含めない**（型の上で持てない）。web-app には「連携しているか」と
 *   「いつからか」だけを渡す約束（P1 QA 要件 3）で、LINE の生 ID を Web 側に流出させない。
 *   下の getLinkageStatus は select も `linked_at, unfollowed_at` に絞ってあり、うっかり足しても
 *   型と クエリ の両方を直さない限り漏れない構造にしている。
 */
export type CustomerLinkageStatus = {
  /** 連携行が 1 件以上あるか（＝ shopify_customer_id が立っているか）。 */
  linked: boolean;
  /** 連携のうち最も古い linked_at（＝いつから連携しているか）。無ければ null。 */
  linkedAt: string | null;
  /** 連携行の件数（N:1 = 世帯共有で 2 以上になりうる）。 */
  count: number;
  /**
   * 連携はあるが **どの LINE にも今は届かない**（全行が unfollowed）か。
   * 連携が無いとき（count=0）は false。連携の有無とは独立した事実。
   */
  unfollowed: boolean;
};

export type CustomerLinkageStatusResult =
  | { ok: true; status: CustomerLinkageStatus }
  | { ok: false; error: string };

/**
 * Shopify 顧客に紐づく「今有効な」LINE 連携の状態を読む（P1: マイページの連携状態表示）。
 *
 * これまで customer_linkages は書き込み（upsert / clear）専用で、**Web から状態を読む経路が
 * 無かった**。そのため連携が成立してもマイページの表示は何も変わらず、お客さまが
 * 「連携できたのか分からない」状態に置かれていた。本関数がその読み取り口の中身。
 *
 * ## 「連携済み」の定義（P4 で訂正・2026-08-22）
 *   `shopify_customer_id = 指定顧客` の行が **1 件以上**あれば連携済み。
 *   - migration 027 で同一 Shopify 顧客に複数 LINE を許す（N:1・世帯共有）ため、件数は 1 とは限らない。
 *     UI は有無だけを出すが、判断材料として count も返す。
 *   - **`unfollowed_at` は条件に入れない**（上の「連携可否と配信可否は別の問い」を読むこと）。
 *     以前はここに `unfollowed_at IS NULL` があったため、LINE 公式アカウントをブロックした
 *     お客さまが「連携解除」扱いになり、Web の人格が空の `line:` 棚へ落ちていた。
 *     届くかどうかは `unfollowed` として**別のフィールドで**返す。
 *   - clearCustomerLinkage による解除は shopify_customer_id を null にするので、
 *     この検索条件では最初からヒットしない（行削除ではないが未連携として扱われる）。
 *     連携が消える経路は**解除だけ**、が P4 後の不変条件。
 *
 * never throw（呼び出し側のマイページ描画を落とさない）。失敗は ok:false で返す。
 */
export async function getLinkageStatus(
  supabase: SupabaseClient,
  shopifyCustomerId: string,
): Promise<CustomerLinkageStatusResult> {
  if (!shopifyCustomerId) {
    return { ok: false, error: "shopifyCustomerId is required" };
  }

  try {
    const { data, error } = await supabase
      .from("customer_linkages")
      // ⚠ line_user_id を select しない（生値を持ち出さない・QA 要件 3 の構造的担保）。
      //   unfollowed_at は時刻であって識別子ではないので、最小開示を崩さない。
      .select("linked_at, unfollowed_at")
      .eq("shopify_customer_id", shopifyCustomerId)
      // 最古を先頭に（linked_at が null の行は末尾に寄せる）。
      .order("linked_at", { ascending: true, nullsFirst: false });

    if (error) return { ok: false, error: error.message };

    const rows = (data ?? []) as Array<{
      linked_at?: string | null;
      unfollowed_at?: string | null;
    }>;
    const linkedAt = rows.find((row) => !!row.linked_at)?.linked_at ?? null;
    /* 1 件でも生きている行があれば「届く」。全滅のときだけ unfollowed=true。
       連携が 0 件のときは false（届かないのではなく、そもそも相手がいない）。 */
    const unfollowed =
      rows.length > 0 && rows.every((row) => row.unfollowed_at != null);

    return {
      ok: true,
      status: { linked: rows.length > 0, linkedAt, count: rows.length, unfollowed },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 逆引き（LINE userId → Shopify 顧客）の結果。
 *
 * ⚠ `getLinkageStatus`（順引き）と非対称に **`shopifyCustomerId` を含む**。
 *   順引きが line_user_id を返さないのは「Web 側が知る必要が無い他人の生 ID を渡さない」
 *   ためだが、逆引きの用途は真逆で、**呼び出し側が既にサーバ検証済みで持っている
 *   LINE userId から、その本人が誰の棚を見るべきかを決める**こと。ここで顧客 ID を
 *   返さないと本人解決が成立しない（それが「マイページ分裂」の根因そのもの）。
 *   信頼境界は順引きと同一（X-API-Key を持つサーバのみ）。
 */
export type LineUserLinkage = {
  /** 連携行があるか。 */
  linked: boolean;
  /** 連携先の Shopify 顧客 ID（数値文字列）。未連携・曖昧なら null。 */
  shopifyCustomerId: string | null;
  /** 連携日時（ISO 8601）。無ければ null。 */
  linkedAt: string | null;
  /** ヒットした行の件数。0 / 1 が正常。2 以上は台帳の異常（下記）。 */
  count: number;
  /**
   * この LINE には今メッセージが届かない（friend 解除 / ブロック）か。
   * **連携の有無とは独立**（上の「連携可否と配信可否は別の問い」）。未連携なら false。
   */
  unfollowed: boolean;
};

export type LineUserLinkageResult =
  | { ok: true; linkage: LineUserLinkage }
  | { ok: false; error: string };

/**
 * LINE userId から「今有効な」連携先 Shopify 顧客を引く（本人解決の逆引き）。
 *
 * ## なぜ必要か
 *   web-app の `resolveIdentity` は、LINE セッションのとき `users/line:{lineUserId}` という
 *   別の棚に解決し、連携台帳を一切見ていなかった。そのため「連携済みなのに、メールで
 *   ログインしたときと LINE でログインしたときで別のマイページが見える」。本関数はその
 *   欠陥を塞ぐための読み取り口で、**新しい台帳は作らず既存 customer_linkages を逆から引く**。
 *
 * ## 「連携済み」の定義（順引き getLinkageStatus と同一に揃える）
 *   `line_user_id = 指定 ID` かつ `shopify_customer_id IS NOT NULL`。
 *   - `clearCustomerLinkage`（解除）は `shopify_customer_id` を null にするので、解除後は
 *     ここで自動的にヒットしなくなる（＝解除が本人解決に即座に効く）。
 *   - **`unfollowed_at` は条件に入れない**（P4・2026-08-22）。ここが本番で実際に人を落として
 *     いた場所で、LINE 公式アカウントをブロックしただけの人が「未連携」と判定され、
 *     web-app の `resolveIdentity` が空の `line:` 棚を返していた。届くかどうかは
 *     `unfollowed` として別に返す。
 *
 * ## ⚠ `.single()` を使わない（罠 G-3）
 *   `customer_linkages` は既に N:1（世帯共有）が成立しており、`.single()` は複数行で
 *   PostgREST エラーになる。そのエラーを握り潰す既存コードは「連携済みの人を静かに
 *   未連携に落とす」壊れ方をしている。本関数は配列で受けて件数で判断する。
 *   line_user_id には UNIQUE があるため通常 0 / 1 件だが、**制約が将来外れても
 *   静かに壊れない**ように 2 件以上を明示的に異常として扱う（曖昧なまま「この顧客だ」と
 *   決めるのは、他人の注文履歴を見せる事故に直結するため fail-closed にする）。
 *
 * never throw（呼び出し側の SSR を落とさない）。失敗は ok:false で返す。
 *
 * @param lineUserId route 側で形式検証済みの LINE userId。
 */
export async function getLinkageByLineUser(
  supabase: SupabaseClient,
  lineUserId: string,
): Promise<LineUserLinkageResult> {
  if (!lineUserId) return { ok: false, error: "lineUserId is required" };

  try {
    const { data, error } = await supabase
      .from("customer_linkages")
      .select("shopify_customer_id, linked_at, unfollowed_at")
      .eq("line_user_id", lineUserId)
      .not("shopify_customer_id", "is", null)
      .order("linked_at", { ascending: true, nullsFirst: false });

    if (error) return { ok: false, error: error.message };

    const rows = (data ?? []) as Array<{
      shopify_customer_id?: string | null;
      linked_at?: string | null;
      unfollowed_at?: string | null;
    }>;

    if (rows.length === 0) {
      return {
        ok: true,
        linkage: {
          linked: false,
          shopifyCustomerId: null,
          linkedAt: null,
          count: 0,
          unfollowed: false,
        },
      };
    }

    // 2 件以上 = 1 つの LINE が複数の Shopify 顧客を指している。どちらの棚を見せるかを
    // 推測で決めない（fail-closed）。件数だけ返して呼び出し側に未連携と同じ扱いをさせる。
    const distinct = new Set(rows.map((r) => String(r.shopify_customer_id)));
    if (distinct.size > 1) {
      console.warn(
        `[customer-linkage] ambiguous reverse linkage: ${distinct.size} distinct customers for one LINE user`,
      );
      return {
        ok: true,
        linkage: {
          linked: false,
          shopifyCustomerId: null,
          linkedAt: null,
          count: rows.length,
          unfollowed: false,
        },
      };
    }

    return {
      ok: true,
      linkage: {
        linked: true,
        shopifyCustomerId: String(rows[0].shopify_customer_id),
        linkedAt: rows.find((r) => !!r.linked_at)?.linked_at ?? null,
        count: rows.length,
        /* line_user_id には UNIQUE があるので通常 1 行。全行が切れているときだけ true。 */
        unfollowed: rows.every((r) => r.unfollowed_at != null),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 顧客に紐づく LINE userId 一覧の取得結果。 */
export type LinkedLineUserIdsResult =
  | { ok: true; lineUserIds: string[] }
  | { ok: false; error: string };

/**
 * Shopify 顧客に紐づく「今有効な」LINE userId を列挙する（解除の対象決定に使う内部関数）。
 *
 * ⚠ 戻り値は **cx-agent の内部にとどめる**。HTTP 応答に載せてはならない
 *   （web-app に LINE の生 ID を渡さない約束・P1 QA 要件 3）。解除ハンドラはこの一覧を
 *   使って `clearCustomerLinkage` を呼び、外へは件数だけを返す。
 *
 * ⚠ `.single()` を使わない（罠 G-3）。N:1（世帯共有）で複数行が正常。
 *
 * never throw。失敗は ok:false。
 */
export async function listLinkedLineUserIds(
  supabase: SupabaseClient,
  shopifyCustomerId: string,
): Promise<LinkedLineUserIdsResult> {
  if (!shopifyCustomerId) {
    return { ok: false, error: "shopifyCustomerId is required" };
  }

  try {
    const { data, error } = await supabase
      .from("customer_linkages")
      .select("line_user_id")
      .eq("shopify_customer_id", shopifyCustomerId);

    if (error) return { ok: false, error: error.message };

    const rows = (data ?? []) as Array<{ line_user_id?: string | null }>;
    const ids = rows
      .map((r) => r.line_user_id)
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    return { ok: true, lineUserIds: ids };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 解除対象の決定結果。 */
export type UnlinkTargetResult =
  | { ok: true; targets: string[] }
  | { ok: false; error: "line_user_id is not linked to this customer" };

/**
 * 解除の対象を決める純関数（route が HTTP に翻訳する前の判断）。
 *
 * N:1（世帯共有・migration 027）では 1 顧客に複数の LINE が紐づく。
 *   - `requested` 省略 … その顧客の連携をすべて外す。
 *   - `requested` 指定 … その 1 件だけ外す。ただし **その ID が当の顧客に紐づいて
 *     いることを先に確かめる**。確かめずに通すと、他人の LINE の連携を自分の
 *     顧客 ID で外せてしまう（所有権の確認が無い解除は、他人への嫌がらせ経路になる）。
 *
 * DB にも HTTP にも触れないので、この判断だけを単体で固定できる。
 */
export function resolveUnlinkTargets(
  linkedLineUserIds: string[],
  requested?: string,
): UnlinkTargetResult {
  if (requested === undefined) {
    return { ok: true, targets: linkedLineUserIds };
  }
  if (!linkedLineUserIds.includes(requested)) {
    return { ok: false, error: "line_user_id is not linked to this customer" };
  }
  return { ok: true, targets: [requested] };
}
