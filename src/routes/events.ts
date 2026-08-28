/**
 * @layer CDP
 *
 * events gateway の HTTP 入口 — POST /api/events（CDP 統合 Stage 1）。
 *
 * 契約の正本は `docs/cdp-events-gateway-contract.md`。ここはその実装であり、
 * 契約の説明を二重に書かない。
 *
 * ─ なぜ HTTP の口が要るか ─
 *   L0 は Supabase にあり、elxea-web-app は Supabase クライアントを持たない
 *   （Firestore しか持たない）。web 側で起きた出来事を L0 に載せる経路は
 *   cx-agent 経由しか無い。認証は既存の共有秘密（SYNC_API_SECRET / X-API-Key）を
 *   そのまま使う — 新しい秘密を増やさない（増やすと本番への配布が判断事項になり、
 *   段が Setaka 待ちで止まる）。
 *
 * ─ この口は「捨てない」側に倒れている ─
 *   未知の event_type / channel でも 400 にしない。schema_ok = false で保存し、
 *   200 に `schema_ok` を載せて返す（E1）。400 になるのは **形が壊れている**
 *   （型名に使えない文字・長すぎる）ときと、認証・本文の parse に失敗したときだけ。
 */

import type { Context } from "hono";
import type { Env } from "../index";
import { createSupabaseClient } from "../lib/supabase";
import { requireSyncApiKey } from "../lib/sync-auth";
import { isIdentifierKind } from "../lib/cdp/event-vocabulary";
import { recordCustomerEvent, type CustomerFact, type IntakeResult } from "../lib/cdp/events-gateway";

/** 1 リクエストで受け取れる件数の上限（送り手の暴走で L0 を溢れさせない）。 */
const MAX_EVENTS_PER_REQUEST = 20;

interface EventRequestItem {
  event_type?: unknown;
  channel?: unknown;
  identifier_kind?: unknown;
  identifier_value?: unknown;
  dedupe?: unknown;
  source?: unknown;
  occurred_at?: unknown;
  payload?: unknown;
}

export async function eventsIntakeHandler(c: Context<{ Bindings: Env }>) {
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  const body = await c.req
    .json<{ events?: EventRequestItem[] }>()
    .catch(() => null);

  if (!body || !Array.isArray(body.events)) {
    return c.json({ error: "events 配列が必要" }, 400);
  }
  if (body.events.length === 0) {
    return c.json({ accepted: 0, results: [] });
  }
  if (body.events.length > MAX_EVENTS_PER_REQUEST) {
    return c.json({ error: `events は 1 回 ${MAX_EVENTS_PER_REQUEST} 件まで` }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  const results: Array<IntakeResult & { index: number }> = [];

  for (const [index, raw] of body.events.entries()) {
    const fact = toFact(raw);
    if (!fact) {
      // 形が組み立てられない = そもそも出来事として読めない。
      // 「捨てた」ではなく「読めなかった」なので、理由を返して呼び手に直させる。
      results.push({ index, stored: false, schemaOk: false, reason: "malformed_item" });
      continue;
    }
    const result = await recordCustomerEvent(supabase, fact);
    results.push({ index, ...result });
  }

  // 応答に subject_id は載せない（設計 §3-1「表示しない・URL に出さない」）。
  return c.json({
    accepted: results.filter((r) => r.stored).length,
    results: results.map((r) => ({
      index: r.index,
      stored: r.stored,
      schema_ok: r.schemaOk,
      ...(r.reason ? { reason: r.reason } : {}),
    })),
  });
}

function toFact(raw: EventRequestItem): CustomerFact | null {
  const eventType = str(raw.event_type);
  const channel = str(raw.channel);
  const kind = raw.identifier_kind;
  const identifierValue = str(raw.identifier_value);
  const dedupe = str(raw.dedupe);
  const source = str(raw.source);

  if (!eventType || !channel || !identifierValue || !dedupe || !source) return null;
  if (!isIdentifierKind(kind)) return null;

  const occurredAt = str(raw.occurred_at);
  const payload =
    raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : undefined;

  return {
    eventType,
    channel,
    identifier: { kind, value: identifierValue },
    dedupe,
    source,
    ...(occurredAt && !Number.isNaN(Date.parse(occurredAt)) ? { occurredAt } : {}),
    ...(payload ? { payload } : {}),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
