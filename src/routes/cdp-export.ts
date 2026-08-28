/**
 * @layer CDP
 *
 * 解析側（elxea-cdp / ローカル SQLite）が L0 を取りに来るための読み口
 * （CDP 統合 Stage 3 / 設計 §4-5 物理配置 / §5 E8' / §6-1 Stage 3）。
 *
 * ─ なぜ HTTP の口が要るか ─
 *
 *   L0 は Supabase にあり、解析は Mac 上の SQLite にある（Workers からローカル
 *   ファイルには書けない）。よって「書込は Supabase が受け、日次で SQLite が
 *   吸い上げる」形になる（設計 §4-5）。その吸い上げの経路がここ。
 *
 *   Supabase の service role key を Mac に配る形も選べたが、採らなかった:
 *     - service role key は L0 以外のすべての表を読み書きできる。吸い上げに
 *       必要なのは L0 の**読み取りだけ**なので、権限が広すぎる。
 *     - 秘密の置き場が 1 つ増える（Mac 上に本番 DB の全権鍵が置かれる）。
 *   ここは既存の共有秘密（SYNC_API_SECRET / X-API-Key）をそのまま使い、
 *   **新しい秘密を増やさない**（events gateway の口と同じ方針）。
 *
 * ─ 返さないもの（意図的）─
 *
 *   生の LINE userId / LINE Login の sub / email_hash / 会話本文。
 *   L0 の payload は契約上 PII を持たない（docs/cdp-events-gateway-contract.md §6）。
 *   主体と Shopify 顧客番号の対応（§045 の cdp_subject_shopify_map）も、生の鍵は
 *   Shopify 顧客番号だけ — これは既に SQLite の persons.ec_customer_id にある値で、
 *   置き場が増えない。生 LINE userId を吐けば E5 の「置き場は delivery_identity 1 表」
 *   が破れる（ratchet raw-identity-key-legacy が数えている当のもの）。
 *
 * ─ 読むだけ ─
 *
 *   3 つとも GET で、書き込みは 1 つも無い。L0 の行を消す経路もここには無い
 *   （設計 §4-5 の「直近 90 日で切る」は、SQLite に入ったことを確認してからの
 *   別判断であり、Stage 3 では実装しない）。
 *
 * 契約の詳細は docs/cdp-events-gateway-contract.md §12（Stage 3）。
 */

import type { Context } from "hono";
import type { Env } from "../index";
import { createSupabaseClient } from "../lib/supabase";
import { requireSyncApiKey } from "../lib/sync-auth";

/** 1 リクエストで返す L0 行の上限（吸い上げ側が回数で刻む）。 */
const MAX_EVENT_ROWS = 1000;
const DEFAULT_EVENT_ROWS = 500;

/** L0 から返す列。**ここに挙げた列だけが外に出る**（select * にしない）。 */
const EVENT_COLUMNS =
  "event_seq,subject_id,event_type,channel,schema_ok,occurred_at,recorded_at,source,idempotency_key,payload";

/**
 * GET /api/cdp/l0/events?after_seq=<n>&limit=<n>[&day=YYYY-MM-DD]
 *
 * event_seq 昇順で L0 の行を返す。吸い上げ側は最後に受け取った event_seq を
 * 水位として持ち、次回はその続きから取る。
 *
 * ─ 水位方式だけでは足りない理由（`day` がある理由）─
 *
 *   L0 は追記専用だが、**例外が 1 つある** — GDPR 消去は行を消す（E4 の例外表）。
 *   消去が上流で起きると、水位より下の行が黙って減る。水位は前にしか進まないので
 *   これを永久に拾えず、写し側にだけ消したはずの人の出来事が残る。
 *
 *   そこで日次の件数突合（E8'）が食い違いを見つけた日については、その日を丸ごと
 *   引き直して写しを合わせる。`day` はそのための絞り込みで、**消えたことを写しに
 *   伝える唯一の経路**である。
 *
 *   日の境界は JST（吸い上げジョブが JST で回るため。045 の cdp_l0_daily_counts と
 *   同じ境界）。
 */
export async function cdpL0EventsHandler(c: Context<{ Bindings: Env }>) {
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  const afterSeq = intParam(c.req.query("after_seq"), 0, 0);
  const limit = intParam(c.req.query("limit"), DEFAULT_EVENT_ROWS, 1, MAX_EVENT_ROWS);
  const day = dateParam(c.req.query("day"));
  if (day === undefined) {
    return c.json({ error: "day は YYYY-MM-DD" }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  let query = supabase
    .from("customer_events")
    .select(EVENT_COLUMNS)
    .gt("event_seq", afterSeq);

  if (day !== null) {
    const bounds = jstDayBounds(day);
    query = query.gte("recorded_at", bounds.startUtc).lt("recorded_at", bounds.endUtc);
  }

  const { data, error } = await query.order("event_seq", { ascending: true }).limit(limit);

  if (error) {
    console.error("[cdp/export] l0 events read failed:", error.message);
    return c.json({ error: "read failed" }, 500);
  }

  const rows = data ?? [];
  return c.json({
    rows,
    // 続きがあるときだけ次の起点を返す。無ければ null（＝ここまでで最新）。
    next: rows.length === limit ? (rows[rows.length - 1] as { event_seq: number }).event_seq : null,
  });
}

/**
 * GET /api/cdp/l0/daily-counts?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * E8'（L0 二重物理の日次件数突合）の Supabase 側。SQLite 側が同じ日に同じ数を
 * 持っていなければ、その日の吸い上げが落ちている。数だけを返す（PII なし）。
 */
export async function cdpL0DailyCountsHandler(c: Context<{ Bindings: Env }>) {
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  const from = dateParam(c.req.query("from"));
  const to = dateParam(c.req.query("to"));
  if (from === undefined || to === undefined) {
    return c.json({ error: "from / to は YYYY-MM-DD" }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase.rpc("cdp_l0_daily_counts", {
    p_from: from,
    p_to: to,
  });

  if (error) {
    console.error("[cdp/export] l0 daily counts failed:", error.message);
    return c.json({ error: "read failed" }, 500);
  }
  return c.json(data ?? {});
}

/**
 * GET /api/cdp/l0/subject-map?after_edge_seq=<n>&limit=<n>
 *
 * 主体（canonical）と Shopify 顧客番号の対応。SQLite の persons.subject_id を
 * 1:1 で埋める唯一の材料。解決の判定は 043/045 の SQL 側 1 か所に置いたまま
 * にしてあり、ここでは解き直さない。
 */
export async function cdpSubjectMapHandler(c: Context<{ Bindings: Env }>) {
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  const afterEdgeSeq = intParam(c.req.query("after_edge_seq"), 0, 0);
  const limit = intParam(c.req.query("limit"), DEFAULT_EVENT_ROWS, 1, MAX_EVENT_ROWS);

  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase.rpc("cdp_subject_shopify_map", {
    p_after_edge_seq: afterEdgeSeq,
    p_limit: limit,
  });

  if (error) {
    console.error("[cdp/export] subject map read failed:", error.message);
    return c.json({ error: "read failed" }, 500);
  }
  return c.json(data ?? { rows: [], next: null });
}

// ---------------------------------------------------------------------------
// 引数の読み方（純粋関数・テスト対象）
// ---------------------------------------------------------------------------

/**
 * クエリ引数を整数として読む。読めない値は既定値へ倒し、範囲外は丸める。
 *
 * 400 にしないのは、ここが**運用ジョブ専用の口**だから — 吸い上げが引数の綴りで
 * 止まると、その日の突合が「食い違い」ではなく「観測なし」になる。丸めた事実は
 * 応答の中身（返ってきた件数）で分かる。
 */
export function intParam(raw: string | undefined, fallback: number, min: number, max?: number): number {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  const base = Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
  const lower = Math.max(base, min);
  return max === undefined ? lower : Math.min(lower, max);
}

/**
 * YYYY-MM-DD だけを受け付ける。省略（undefined）は SQL 側の既定（直近 30 日）へ委ねる
 * ため null を返し、形が違うものは undefined（＝呼び出し側が 400 にする）。
 *
 * 日付だけは丸めない。範囲を黙って読み替えると「どの日を突合したのか」が
 * 応答からしか分からなくなり、突合の記録として弱くなる。
 */
export function dateParam(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const t = Date.parse(`${raw}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : raw;
}

/**
 * JST の 1 日（YYYY-MM-DD）を UTC の半開区間 [start, end) に直す。
 *
 * JST は夏時間を持たないので固定 +9 時間でよい（ここが揺れる国だったら
 * この関数は成立しない）。045 の `(recorded_at AT TIME ZONE 'Asia/Tokyo')::date` と
 * **同じ境界**になることがこの関数の唯一の要件で、ずれると突合が毎日食い違う。
 */
export function jstDayBounds(day: string): { startUtc: string; endUtc: string } {
  const startMs = Date.parse(`${day}T00:00:00Z`) - 9 * 60 * 60 * 1000;
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}
