/**
 * 「台帳に行が立った」を web-app に伝える（M-2）。
 *
 * ## なぜ書いた側から知らせるのか
 *
 * 連携が成立すると、web-app 側では `users/line:<LINE ID>/**` に貯まっていた
 * お気に入り・行動ログを `users/<顧客番号>/**` へ運ぶ「合体」が走らなければならない。
 * ところが合体のきっかけは web-app 側の 4 経路にばらばらに置かれていて、
 * **LINE トーク内の Account Link だけはどの経路も通らなかった**。
 *
 * その連携は LINE → cx-agent の webhook だけで完結し、web-app を一度も通らない。
 * つまり web-app 側に合体を始めるきっかけが**構造的に存在しない**。経路ごとに
 * 合図を足していく限り、経路が増えるたびに同じ穴が空く。
 *
 * よって合図を「台帳に行が立った」という **1 イベント**に集約し、それを知っている
 * 唯一の場所 — 書いた側 — から知らせる。
 *
 * ## 連携そのものは絶対に止めない
 *
 * 通知は連携の**後**に起きる出来事で、連携の成否を決める条件ではない。web-app が
 * 落ちていても、鍵が無くても、連携は既に台帳上成立している。よってこの関数は
 * **決して throw せず**、失敗しても呼び出し側の応答を変えない。
 *
 * 落ちた分は web-app 側の照合経路が拾う（次にメールでログインしたときに
 * `completeLineLinkage` が台帳を引き直し、成立していれば合体する）。イベントが
 * 速さを、照合が確実さを担当する。
 *
 * ## 鍵を分ける理由
 *
 * `SYNC_API_SECRET` ではなく専用の `LINKAGE_EVENT_SECRET` を使う。この口は
 * 「この LINE とこの顧客は同一人物である」と**宣言できる**口で、通れば web-app は
 * 元の棚を消して荷物を移す。取り返しがつかない操作なので、他の用途で配った鍵で
 * 開けられるようにしない。
 */

/** 通知先の設定が揃っているか / 何が起きたか。 */
export type LinkageNotifyResult =
  | { ok: true; status: number }
  | { ok: false; reason: "not-configured" | "unreachable" | "rejected"; detail: string };

export type LinkageNotifyInput = {
  /** Messaging userId（台帳に書いたのと同じ値）。 */
  lineUserId: string;
  /** 数値の Shopify 顧客 ID（台帳に書いたのと同じ値）。 */
  shopifyCustomerId: string;
  /** どの経路の連携か。web-app 側では切り分けにしか使わない。 */
  source: string;
};

type NotifyEnv = {
  WEB_APP_BASE_URL?: string;
  LINKAGE_EVENT_SECRET?: string;
};

/** 末尾の空白・改行・スラッシュを落とす（`vercel env add < file` 由来の改行対策と同じ理由）。 */
function readTrimmed(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  return v.length > 0 ? v : undefined;
}

/** 1 回あたりの待ち時間。連携の応答を人が待っているので短く。 */
const TIMEOUT_MS = 4000;

/**
 * web-app に連携成立を通知する。**決して throw しない。**
 *
 * @param fetchImpl テスト用の差し替え。省略時は global fetch。
 */
export async function notifyLinkageEstablished(
  env: NotifyEnv,
  input: LinkageNotifyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkageNotifyResult> {
  const baseUrl = readTrimmed(env.WEB_APP_BASE_URL);
  const secret = readTrimmed(env.LINKAGE_EVENT_SECRET);

  if (!baseUrl || !secret) {
    /* 設定が無いだけ。連携は成立しているので警告に留める。ただし**無音にはしない** —
       ここが黙って落ちると、合体が起きない理由が誰にも分からなくなる。 */
    console.warn(
      "[linkage-notify] WEB_APP_BASE_URL / LINKAGE_EVENT_SECRET 未設定のため合体イベントを送れない（連携自体は成立済み）",
    );
    return { ok: false, reason: "not-configured", detail: "missing env" };
  }

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api/internal/linkage-established`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        line_user_id: input.lineUserId,
        shopify_customer_id: input.shopifyCustomerId,
        source: input.source,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    /* ⚠ 本人の ID はログに出さない。source だけで発生箇所は特定できる。 */
    console.warn(
      `[linkage-notify] web-app へ届かなかった（source=${input.source}）:`,
      err instanceof Error ? err.message : String(err),
    );
    return {
      ok: false,
      reason: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok) {
    console.warn(
      `[linkage-notify] web-app が合体イベントを受け付けなかった（source=${input.source}, status=${res.status}）`,
    );
    return { ok: false, reason: "rejected", detail: `status=${res.status}` };
  }

  console.log(`[linkage-notify] 合体イベント送信済み（source=${input.source}）`);
  return { ok: true, status: res.status };
}
