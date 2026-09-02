/**
 * @layer CDP
 *
 * 送った記録の台帳を読む HTTP の口（roji タッチポイント地図 A-0）。
 *
 * 設計正本: roji体験目的 × タッチポイント全体地図（2026-09-02・Setaka 承認済み）第4章 A-0
 * SQL 側の本体: `src/db/migrations/053_cdp_delivery_readout.sql`
 * TS 側の読み手: `src/lib/cdp/delivery-history.ts`
 *
 * ─ なぜ HTTP の口が要るか ─
 *
 *   台帳は Supabase にあり、**elxea-web-app は Supabase クライアントを持たない**
 *   （Firestore と Sanity と Shopify だけ）。じぶんのページ・今月のお茶が
 *   「この人に何が届いたか」を知る経路は cx-agent 経由しか無い。
 *   認証は既存の共有秘密（`SYNC_API_SECRET` / `X-API-Key`）をそのまま使う —
 *   **新しい秘密を増やさない**（events gateway / L0 の吸い上げ口と同じ方針）。
 *
 * ─ なぜ GET ではなく POST か（読み取り専用なのに）─
 *
 *   引数に **人を指す鍵**が入るため。GET にすると鍵が URL に載り、アクセスログ・
 *   Referer・プロキシの記録に残る。L0 の吸い上げ口（`/api/cdp/l0/*`）が GET なのは
 *   引数が水位と日付だけで人を指さないからで、ここはその条件を満たさない。
 *   設計 §3-1 の「表示しない・URL に出さない」を、口の側でも守る。
 *   **副作用は 1 つも無い**（SQL 側の関数は STABLE で、INSERT / UPDATE / DELETE を含まない）。
 *
 * ─ 返さないもの（意図的）─
 *
 *   subject_id / 生の LINE userId / Shopify 顧客番号 / 住所・宛名・メール /
 *   台帳の自由文（038 の note）/ 033 の凍結した推定・運営の判断。
 *   返るのは「月・号・銘柄・数量・届いた日・出所タグ」だけである。
 */

import type { Context } from "hono";
import type { Env } from "../index";
import { createSupabaseClient } from "../lib/supabase";
import { requireSyncApiKey } from "../lib/sync-auth";
import { isIdentifierKind } from "../lib/cdp/event-vocabulary";
import {
  readDeliveryHistory,
  type DeliveryHistoryMonth,
} from "../lib/cdp/delivery-history";

interface DeliveryHistoryRequest {
  identifier_kind?: unknown;
  identifier_value?: unknown;
  months?: unknown;
}

/**
 * POST /api/cdp/delivery/history
 *
 * body: `{ identifier_kind, identifier_value, months? }`
 * 200 : `{ found, reason?, months?, keys?, periods: [...] }`
 *
 * ─ 見つからないときも 200 で返す理由 ─
 *   「この人の履歴が引けなかった」は呼び出し側にとって **表示すべき状態**であって
 *   要求の誤りではない。404 にすると、web-app 側は「口が無い」のか「履歴が無い」のか
 *   を応答コードから切り分けられない。理由は本文の `reason` に載せる。
 *   400 になるのは、鍵の種類が語彙に無い等 **要求そのものが組み立てられない**ときだけ。
 */
export async function cdpDeliveryHistoryHandler(c: Context<{ Bindings: Env }>) {
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  const body = await c.req.json<DeliveryHistoryRequest>().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "JSON の本文が必要" }, 400);
  }

  const kind = body.identifier_kind;
  if (!isIdentifierKind(kind)) {
    return c.json({ error: "identifier_kind が語彙に無い" }, 400);
  }
  const value = typeof body.identifier_value === "string" ? body.identifier_value.trim() : "";
  if (value === "") {
    return c.json({ error: "identifier_value が必要" }, 400);
  }

  // 月数は丸める（綴りで読み口が止まらないようにする。丸めた事実は応答の months で分かる）。
  const months =
    typeof body.months === "number" && Number.isFinite(body.months)
      ? Math.trunc(body.months)
      : undefined;

  const supabase = createSupabaseClient(c.env);
  const result = await readDeliveryHistory(supabase, { kind, value }, { months });

  return c.json({
    found: result.found,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.months !== undefined ? { months: result.months } : {}),
    ...(result.keys ? { keys: result.keys } : {}),
    periods: result.periods.map(toWire),
  });
}

/**
 * 内部の型 → 応答の形（snake_case）。
 *
 * 口の語彙を内部の型名と切り離しておく。内部でプロパティ名を変えたときに、
 * **web-app 側が黙って壊れる**ことがないようにするため（口は契約である）。
 */
function toWire(month: DeliveryHistoryMonth) {
  return {
    period: month.period,
    assigned: month.assigned
      ? {
          issue_ref: month.assigned.issueRef,
          teas: month.assigned.teas.map((t) => ({ product_no: t.productNo, name: t.name })),
          basis: month.assigned.basis,
        }
      : null,
    delivered: month.delivered.map((d) => ({
      item_ref: d.itemRef,
      item_name: d.itemName,
      item_kind: d.itemKind,
      quantity: d.quantity,
      delivered_on: d.deliveredOn,
      date_basis: d.dateBasis,
      source: d.source,
    })),
  };
}
