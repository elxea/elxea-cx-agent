/**
 * 配送台帳への書き込み —「誰に・いつ・何が(どの茶葉が)届いたか」を事実として残す。
 *
 * 仕様の正本: elxea CX Agent機能定義 v1.5
 *   https://www.notion.so/3b970c9d064c81ddb60ff08c23152929  3-2 / 第5節 タスク9
 * 器の正本: `src/db/migrations/038_tea_delivery_ledger.sql`（本モジュールは DDL を足さない）
 *
 * ─ なぜ必要か ─
 *   「手元のお茶から1杯を選ぶ」は CX Agent の代表用途だが、届いた記録が無いと原理的に成立しない。
 *   しかもこの記録は**過去に遡って作れない**。だから表に出す前でも今から書き始める。
 *
 * ─ このモジュールの姿勢 ─
 *   - **純粋**。ネットワーク I/O は `DeliveryLedgerStore` の向こう側だけ（テストは fake を注入）。
 *   - **推測で埋めない**。分類が分からない品は 'unknown' のまま書く（'tea' と決めつけない）。
 *   - **送信しない**。LINE / メール / Slack を 1 つも import しない。
 *   - 誰の記録か分からない行（鍵が両方とも無い＝ guest checkout）は**作らずスキップ**する。
 */

// ---------------------------------------------------------------------------
// 台帳へ書く 1 行
// ---------------------------------------------------------------------------

/** 品の分類。分からないものは 'unknown'（後から商品マスタの分類で直す）。 */
export type DeliveryItemKind = "tea" | "goods" | "other" | "unknown";

/** 日付が何に基づくか。ordered < fulfilled < manual の順に確からしい。 */
export type DeliveryDateBasis = "ordered" | "fulfilled" | "manual";

/** どこから来た記録か。 */
export type DeliverySource = "shopify_order" | "manual" | "roji_assignment";

/** 台帳の 1 行（migration 038 の列に 1:1 対応。SQL への写しは store 側）。 */
export interface DeliveryRecord {
  /** 名寄せ後の統一 ID（EC 上の顧客番号）。EC 開店前は無い。 */
  shopifyCustomerId: string | null;
  /** EC の顧客番号がまだ無い間の鍵。 */
  lineUserId: string | null;
  /** 届いた日（YYYY-MM-DD・JST 基準）。 */
  deliveredOn: string;
  dateBasis: DeliveryDateBasis;
  itemKind: DeliveryItemKind;
  /** 銘柄の参照（Shopify product id / roji の茶の ref / 手動の slug）。正本は商品マスタ側。 */
  itemRef: string;
  itemVariantRef: string | null;
  /** その時点の表示名の写し（商品が改名・削除されても中身が残るように持つ）。 */
  itemName: string | null;
  quantity: number;
  source: DeliverySource;
  /** 出所の参照（注文 ID / 手動投入の根拠 / 033 の period）。 */
  sourceRef: string;
  /** 明細の参照（Shopify の line_item ID / 手動の連番）。二重計上を防ぐ鍵の一部。 */
  sourceLineRef: string;
  /** 手動投入の出所メモ。個人を特定する記述は書かない。 */
  note: string | null;
}

/** 書き込みの結果（件数のみ。誰の行かは返さない）。 */
export interface DeliveryWriteResult {
  inserted: number;
  updated: number;
  /** 既存行の方が確かな日付を持っていたため触らなかった件数。 */
  kept: number;
}

/** 台帳への口（実装は Supabase / pg。テストは fake）。 */
export interface DeliveryLedgerStore {
  record(rows: DeliveryRecord[]): Promise<DeliveryWriteResult>;
}

// ---------------------------------------------------------------------------
// Shopify 注文 → 台帳の行（純粋）
// ---------------------------------------------------------------------------

/** 本モジュールが読む注文の最小形（Shopify 注文 payload と構造的に互換）。 */
export interface DeliverySourceOrder {
  id?: number | string;
  created_at?: string;
  customer?: { id?: number | string | null } | null;
  line_items?: Array<{
    id?: number | string | null;
    product_id?: number | string | null;
    variant_id?: number | string | null;
    title?: string | null;
    variant_title?: string | null;
    name?: string | null;
    sku?: string | null;
    quantity?: number | null;
  }> | null;
  fulfillments?: Array<{
    created_at?: string | null;
    status?: string | null;
  }> | null;
}

export interface ExtractDeliveryOptions {
  /** 商品 ID → タグ（webhook が既に引いている map をそのまま渡す）。分類にのみ使う。 */
  productTags?: Map<string, string[]>;
  /** 名寄せ後の統一 ID が別経路で判明しているとき（注文に顧客が付かない手渡し等）。 */
  lineUserId?: string | null;
}

/** ISO8601（オフセット付き）→ JST の暦日（YYYY-MM-DD）。 */
export function toJstDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`toJstDate: 日付として読めない値: ${iso}`);
  // JST = UTC+9（日本の事業なので夏時間は無い）。
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** タグから分類を決める。**分からなければ 'unknown'**（推測で 'tea' にしない）。 */
export function classifyItemKind(tags: string[] | undefined): DeliveryItemKind {
  if (!tags || tags.length === 0) return "unknown";
  const joined = tags.join(" ").toLowerCase();
  // 雑貨を先に見る（「茶器」「茶さじ」は茶ではない。茶の判定を先にすると飲めない品が茶になる）。
  if (/雑貨|goods|茶器|急須|湯呑|茶さじ|tool/.test(joined)) return "goods";
  if (/茶|tea/.test(joined)) return "tea";
  return "unknown";
}

/**
 * 注文 1 件 → 台帳の行（銘柄ごとに 1 行）。
 *
 * 届いた日: 発送の記録があればその日（fulfilled）、無ければ注文日で代用（ordered）。
 *   後から発送の webhook が来たら `date_basis` の順位が上がり、DB 側が上書きを許す（038）。
 * 鍵: EC 上の顧客番号。無ければ opts.lineUserId。**どちらも無ければ 0 行**（guest checkout）。
 */
export function extractDeliveryRecords(
  order: DeliverySourceOrder,
  opts: ExtractDeliveryOptions = {},
): DeliveryRecord[] {
  const orderId = order.id == null ? "" : String(order.id).trim();
  if (orderId.length === 0) return [];

  const rawCustomer = order.customer?.id;
  const shopifyCustomerId =
    rawCustomer == null
      ? null
      : (() => {
          const id = String(rawCustomer)
            .replace(/^gid:\/\/shopify\/Customer\//, "")
            .trim();
          return /^\d+$/.test(id) ? id : null;
        })();
  const lineUserId = opts.lineUserId?.trim() || null;

  // 誰の記録か分からない行は作らない（038 の CHECK と同じ判断をアプリ側でも持つ）。
  if (!shopifyCustomerId && !lineUserId) return [];

  const fulfilledAt = (order.fulfillments ?? []).find(
    (f) => f?.created_at && (f.status ?? "success") !== "cancelled",
  )?.created_at;
  const basis: DeliveryDateBasis = fulfilledAt ? "fulfilled" : "ordered";
  const dateSource = fulfilledAt ?? order.created_at;
  if (!dateSource) return [];
  const deliveredOn = toJstDate(dateSource);

  const rows: DeliveryRecord[] = [];
  const items = order.line_items ?? [];
  items.forEach((item, index) => {
    const productId = item.product_id == null ? "" : String(item.product_id).trim();
    const variantId = item.variant_id == null ? "" : String(item.variant_id).trim();
    const sku = (item.sku ?? "").trim();
    // 銘柄の参照。product_id が本命で、無ければ variant / sku に落とす。全部無ければ書かない。
    const itemRef = productId || (variantId ? `variant:${variantId}` : sku ? `sku:${sku}` : "");
    if (!itemRef) return;

    const name = (item.title ?? item.name ?? "").trim() || null;
    const variantTitle = (item.variant_title ?? "").trim();
    rows.push({
      shopifyCustomerId,
      lineUserId,
      deliveredOn,
      dateBasis: basis,
      itemKind: classifyItemKind(productId ? opts.productTags?.get(productId) : undefined),
      itemRef,
      itemVariantRef: variantId || null,
      itemName: variantTitle && name ? `${name} / ${variantTitle}` : name,
      quantity: Math.max(1, Math.trunc(item.quantity ?? 1)),
      source: "shopify_order",
      sourceRef: `order:${orderId}`,
      // 明細 ID が無い payload でも二重計上しないよう、順番を混ぜた安定キーにする。
      sourceLineRef: item.id != null ? String(item.id) : `${itemRef}#${index}`,
      note: null,
    });
  });

  return rows;
}

// ---------------------------------------------------------------------------
// 手動投入（EC 開店前・マルシェ手渡し・遡りの補完）
// ---------------------------------------------------------------------------

/** 手動投入の 1 件（人が書く形）。 */
export interface ManualDeliveryInput {
  shopifyCustomerId?: string | null;
  lineUserId?: string | null;
  /** 届いた日（YYYY-MM-DD）。 */
  deliveredOn: string;
  /** 出所の根拠（"marche-2026-07-20" 等）。同じ根拠の中で明細の順番が鍵になる。 */
  sourceRef: string;
  note?: string | null;
  items: Array<{
    itemRef: string;
    itemName?: string | null;
    itemKind?: DeliveryItemKind;
    quantity?: number;
    /** 明細の参照を明示したいとき（省略時は 1 始まりの連番）。 */
    lineRef?: string;
  }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 手動投入 → 台帳の行。**検証は厳しく**（人が書くので、静かに歪んだ記録を残さない）。
 * 同じ sourceRef で再実行しても行は増えない（明細の参照が安定した連番のため）。
 */
export function buildManualDeliveryRecords(input: ManualDeliveryInput): DeliveryRecord[] {
  const shopifyCustomerId = input.shopifyCustomerId?.trim() || null;
  const lineUserId = input.lineUserId?.trim() || null;
  if (!shopifyCustomerId && !lineUserId) {
    throw new Error("手動投入: 誰に届いたかが無い（shopifyCustomerId か lineUserId のどちらかは必須）");
  }
  if (!DATE_RE.test(input.deliveredOn)) {
    throw new Error(`手動投入: 届いた日は YYYY-MM-DD で書く（受領: ${input.deliveredOn}）`);
  }
  const sourceRef = input.sourceRef.trim();
  if (!sourceRef) throw new Error("手動投入: 出所の根拠（sourceRef）が空");
  if (!input.items || input.items.length === 0) {
    throw new Error("手動投入: 中身（items）が空。何が届いたか分からない記録は作らない");
  }

  return input.items.map((item, index) => {
    const itemRef = item.itemRef?.trim();
    if (!itemRef) throw new Error(`手動投入: ${index + 1} 件目の銘柄（itemRef）が空`);
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`手動投入: ${itemRef} の数量が不正（受領: ${item.quantity}）`);
    }
    return {
      shopifyCustomerId,
      lineUserId,
      deliveredOn: input.deliveredOn,
      dateBasis: "manual" as const,
      itemKind: item.itemKind ?? "unknown",
      itemRef,
      itemVariantRef: null,
      itemName: item.itemName?.trim() || null,
      quantity,
      source: "manual" as const,
      sourceRef,
      sourceLineRef: item.lineRef?.trim() || String(index + 1),
      note: input.note?.trim() || null,
    };
  });
}

// ---------------------------------------------------------------------------
// 実 I/O（Supabase RPC。規則は DB 側の record_tea_deliveries が持つ）
// ---------------------------------------------------------------------------

/** 台帳の行 → RPC に渡す jsonb（列名は snake_case）。 */
export function toLedgerPayload(rows: DeliveryRecord[]): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    shopify_customer_id: r.shopifyCustomerId,
    line_user_id: r.lineUserId,
    delivered_on: r.deliveredOn,
    date_basis: r.dateBasis,
    item_kind: r.itemKind,
    item_ref: r.itemRef,
    item_variant_ref: r.itemVariantRef,
    item_name: r.itemName,
    quantity: r.quantity,
    source: r.source,
    source_ref: r.sourceRef,
    source_line_ref: r.sourceLineRef,
    note: r.note,
  }));
}

/** supabase-js の最小形（実クライアントを import せず、テストで差し替え可能にする）。 */
export interface RpcCapableClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

/** Supabase RPC（record_tea_deliveries）を叩く store。 */
export function createSupabaseDeliveryLedgerStore(
  client: RpcCapableClient,
): DeliveryLedgerStore {
  return {
    async record(rows: DeliveryRecord[]): Promise<DeliveryWriteResult> {
      if (rows.length === 0) return { inserted: 0, updated: 0, kept: 0 };
      const { data, error } = await client.rpc("record_tea_deliveries", {
        p_rows: toLedgerPayload(rows),
      });
      if (error) throw new Error(`配送台帳への書き込みに失敗: ${error.message}`);
      const d = (data ?? {}) as Partial<DeliveryWriteResult>;
      return {
        inserted: d.inserted ?? 0,
        updated: d.updated ?? 0,
        kept: d.kept ?? 0,
      };
    },
  };
}
