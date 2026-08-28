/**
 * @layer CDP
 *
 * 解釈を動かす出来事の受け口 — 安全申告 / 「もういらない」 / 事前通知 / 本人訂正 / 点の増減
 * （CDP 統合 Stage 4 / 設計 §4 #18 / §6-1 Stage 4「exclusions・overrides・notify 受け口」）。
 *
 * ─ いま何が無いか（#18）─
 *
 *   事前通知への変更・安全に関する申告・本人訂正には **置き場が無い**。roji Spec が
 *   必須材料と呼んでいるのに、書ける場所がどこにもない（＝ 通知の再開はこの後）。
 *
 * ─ なぜ L1 に直接書かないのか ─
 *
 *   L1（subject_profile）の列を直接書ける口を開けると、「解釈を直接書き換える経路」が
 *   でき、L1 が L0 から再計算できなくなる。Stage 4 の不変条件（L1 は L0 から全再計算
 *   可能）はそこで壊れる。よってこの受け口は **L0 に 1 行積むだけ**にして、L1 は
 *   それを畳んだ結果として現れる。畳み方の正本は migration 046 の
 *   cdp_l1_build_profile 1 か所（TypeScript には畳み方を持たない）。
 *
 * ─ この層が足すもの ─
 *
 *   events gateway（recordCustomerEvent）は「どんな出来事でも捨てずに積む」汎用の口で、
 *   payload の中身は見ない。ここは **意味の決まった 5 家族**について、
 *   型・冪等キー・source slug を 1 か所に決める薄い層である。
 *   （汎用の口は POST /api/events としてそのまま残る — web-app からはそちらを使う。
 *     契約は docs/cdp-events-gateway-contract.md。）
 *
 * ─ PII ─
 *   payload に生の LINE userId・メール・自由文の本文は載せない。安全申告の自由記述
 *   （SafetyDeclaration.freeText）は **載せない**（有無だけを載せる）。本文の置き場は
 *   カルテであって L0 ではない。
 *
 * ─ 外部送信はしない ─
 *   ここは記録の口だけを持つ。通知の送信経路は一切 import しない。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordCustomerEvent, type CustomerFact, type IntakeResult } from "./events-gateway";
import type { ObservedIdentifier } from "./subjects";

/** 好みタイプの増減（3 軸。省略した軸は 0）。 */
export interface PersonaDelta {
  serenity?: number;
  explorer?: number;
  sensory?: number;
}

/** 点の出所（TS 側 PersonaScoreSource と同じ語彙。L1 の内訳のバケツ名になる）。 */
export type PersonaSignalSource = "diagnosis" | "survey" | "purchase" | "conversation";

/** どの人の出来事か + いつ + どの経路が観測したか。 */
export interface ProfileIntakeContext {
  identifier: ObservedIdentifier;
  /** 経路の slug（L0 の source 列。冪等キーにも入る）。 */
  source: string;
  /** 起きた時刻（ISO8601）。省略時は now。 */
  occurredAt?: string;
  /** 出来事のチャネル。省略時は identifier の種類から決める。 */
  channel?: string;
}

const PERSONA_AXES = ["serenity", "explorer", "sensory"] as const;

/** identifier の種類からチャネルを決める（呼ぶ側ごとに分岐させない）。 */
function channelFor(identifier: ObservedIdentifier): string {
  switch (identifier.kind) {
    case "web_session_id":
    case "web_anonymous_id":
      return "web";
    case "shopify_customer_id":
      return "shopify";
    default:
      return "line";
  }
}

function fact(
  ctx: ProfileIntakeContext,
  eventType: string,
  dedupe: string,
  payload: Record<string, unknown>,
): CustomerFact {
  return {
    eventType,
    channel: ctx.channel ?? channelFor(ctx.identifier),
    identifier: ctx.identifier,
    dedupe,
    source: ctx.source,
    ...(ctx.occurredAt ? { occurredAt: ctx.occurredAt } : {}),
    payload,
  };
}

/** 増減を 3 軸の数値に正規化する（0 の軸は落とす = 意味のない行を作らない）。 */
export function normalizeDelta(delta: PersonaDelta): Record<string, number> {
  const out: Record<string, number> = {};
  for (const axis of PERSONA_AXES) {
    const v = delta[axis];
    if (typeof v === "number" && Number.isFinite(v) && v !== 0) out[axis] = v;
  }
  return out;
}

/**
 * 2 つのスコアの差を増減にする（純粋）。
 *
 * ─ なぜ差を採るのか ─
 *   点を動かす既存の計算（mergePersonaScoresWithSource）は「押し替えの取り消し」を
 *   含むので、**足した分**と**実際に動いた分**が一致しない。呼ぶ側が weight を
 *   書き写すと、取り消しの回だけ L0 と Firestore がずれる。前後の差なら必ず一致する。
 */
export function personaDeltaFromScores(
  before: PersonaDelta | undefined,
  after: PersonaDelta | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const axis of PERSONA_AXES) {
    const b = num(before?.[axis]);
    const a = num(after?.[axis]);
    if (a - b !== 0) out[axis] = a - b;
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// 受け口（すべて never throw。呼ぶ側の応答を止めない）
// ---------------------------------------------------------------------------

/**
 * 点が動いた 1 回分を L0 に積む。
 *
 * 増減が全部 0 なら **何も積まない**（意味のない行を作らない。TS 側
 * addPersonaScoreSourceDeltas が「全部 0 なら lastUpdated も動かさない」のと同じ作法）。
 */
export async function recordPersonaSignal(
  supabase: SupabaseClient,
  ctx: ProfileIntakeContext,
  args: { source: PersonaSignalSource; delta: PersonaDelta; dedupe?: string },
): Promise<IntakeResult> {
  const delta = normalizeDelta(args.delta);
  if (Object.keys(delta).length === 0) {
    return { stored: false, schemaOk: true, reason: "empty_delta" };
  }
  const occurredAt = ctx.occurredAt ?? new Date().toISOString();
  return recordCustomerEvent(
    supabase,
    fact(
      { ...ctx, occurredAt },
      "persona.signal_applied",
      args.dedupe ?? `${args.source}@${occurredAt}`,
      { source: args.source, delta },
    ),
  );
}

/**
 * 移行の起点を 1 回だけ積む（Firestore に既に貯まっていた点を L1 の土台にする）。
 *
 * これが無いと L1 は「記録を始めてから」の点しか持てず、新旧の配信対象が構造的に
 * ずれ続ける（Stage 4 の完了条件「配信対象が新旧で一致」に永久に届かない）。
 * 冪等キーは既定で主体ごとに 1 回（同じ人に 2 回目を積んでも L0 が 1 行に畳む）。
 */
export async function recordPersonaBaseline(
  supabase: SupabaseClient,
  ctx: ProfileIntakeContext,
  args: {
    scores: PersonaDelta;
    sources?: Record<string, PersonaDelta>;
    /** 移行の版（作り直したいときだけ変える。既定は 1 回きり）。 */
    revision?: string;
  },
): Promise<IntakeResult> {
  const scores: Record<string, number> = {};
  for (const axis of PERSONA_AXES) scores[axis] = num(args.scores?.[axis]);

  return recordCustomerEvent(
    supabase,
    fact(ctx, "persona.baseline_imported", `baseline:${args.revision ?? "1"}`, {
      scores,
      ...(args.sources ? { sources: args.sources } : {}),
    }),
  );
}

/**
 * 「もういらない」を積む / 解除する（項目13・割当の必須条件）。
 *
 * 冪等キーに銘柄番号を入れるので、同じお茶を 2 回押しても 1 行。解除は別の型なので
 * 「入れた → 外した → また入れた」がそのまま順番に残る（押し順が結果を決める）。
 */
export async function recordExclusion(
  supabase: SupabaseClient,
  ctx: ProfileIntakeContext,
  args: { ref: string; cleared?: boolean; at?: string },
): Promise<IntakeResult> {
  const ref = typeof args.ref === "string" ? args.ref.trim() : "";
  const stamp = args.at ?? ctx.occurredAt ?? new Date().toISOString();
  return recordCustomerEvent(
    supabase,
    fact(
      ctx,
      args.cleared ? "exclusion.cleared" : "exclusion.set",
      `tea:${ref}@${stamp}`,
      { kind: "tea", ref },
    ),
  );
}

/**
 * 安全に関する申告を積む（項目6）。
 *
 * ─ 自由記述は載せない ─
 *   カルテ側（SafetyDeclaration.freeText）に本文は残る。L0 には **有無だけ**を載せる。
 * ─ 取り消しの口は作らない ─
 *   カルテ定義が「片方にでも申告があれば必ず残す。消す方向の統合を絶対にしない」と
 *   定めているので、L1 の畳み手も union のみ。取り消せる口をここに作れば、その定義は
 *   実質無効になる。撤回が要るなら、それは人の判断を挟む別の手続きにする。
 */
export async function recordSafetyDeclaration(
  supabase: SupabaseClient,
  ctx: ProfileIntakeContext,
  args: { tags: string[]; hasFreeText?: boolean; at?: string },
): Promise<IntakeResult> {
  const tags = (Array.isArray(args.tags) ? args.tags : [])
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter((t) => t.length > 0);
  const stamp = args.at ?? ctx.occurredAt ?? new Date().toISOString();
  return recordCustomerEvent(
    supabase,
    fact(ctx, "safety.declared", `safety:${tags.slice().sort().join("+")}@${stamp}`, {
      tags,
      has_free_text: args.hasFreeText === true,
    }),
  );
}

/** 事前通知の設定（key / value）。最後の設定が勝つ。 */
export async function recordNotifyPreference(
  supabase: SupabaseClient,
  ctx: ProfileIntakeContext,
  args: { key: string; value: unknown; at?: string },
): Promise<IntakeResult> {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  const stamp = args.at ?? ctx.occurredAt ?? new Date().toISOString();
  return recordCustomerEvent(
    supabase,
    fact(ctx, "notify.preference_set", `notify:${key}@${stamp}`, {
      key,
      value: args.value ?? null,
    }),
  );
}

/**
 * 「もう送らないで」/ 再開。配信の宛先解決（cdp_segment_line_targets）が実際に外す。
 *
 * ⚠ ここは記録だけ。**この関数は何も送らないし、何も止めない** — 止まるのは
 *   L1 が畳み直されて subject_segment_state.in_segment が false になったときで、
 *   畳み直しは日次 tick（stage4-parity）と受け口の直後の再計算が行う。
 */
export async function recordNotifySuppression(
  supabase: SupabaseClient,
  ctx: ProfileIntakeContext,
  args: { suppressed: boolean; reason?: string; at?: string },
): Promise<IntakeResult> {
  const stamp = args.at ?? ctx.occurredAt ?? new Date().toISOString();
  return recordCustomerEvent(
    supabase,
    args.suppressed
      ? fact(ctx, "notify.suppressed", `suppress@${stamp}`, {
          reason: (args.reason ?? "").trim() || "requested_by_person",
        })
      : fact(ctx, "notify.resumed", `resume@${stamp}`, {}),
  );
}

/** 本人訂正（field / value）。最後の訂正が勝つ。 */
export async function recordProfileOverride(
  supabase: SupabaseClient,
  ctx: ProfileIntakeContext,
  args: { field: string; value: unknown; at?: string },
): Promise<IntakeResult> {
  const field = typeof args.field === "string" ? args.field.trim() : "";
  const stamp = args.at ?? ctx.occurredAt ?? new Date().toISOString();
  return recordCustomerEvent(
    supabase,
    fact(ctx, "profile.override", `override:${field}@${stamp}`, {
      field,
      value: args.value ?? null,
    }),
  );
}
