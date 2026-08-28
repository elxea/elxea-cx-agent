/**
 * @layer CDP
 *
 * events gateway — 顧客の事実を書く「口」（CDP 統合 Stage 1 / 設計 §5 E1・E2・E3 / §6-1 Stage 1）。
 *
 * ─ Stage 1 でのこの関数の立ち位置 ─
 *
 *   既存の 5 経路（flow_events / Firestore behaviorLog / product_ratings /
 *   購入 / roji アンケート）を **透過で通す**。書込先は当面いまのままで、
 *   同じ出来事を L0（customer_events）にも 1 行積む（二重書き）。
 *
 *   だから `throughGateway` は「元の書き込みを引数で受け取り、そのまま呼ぶ」形をしている。
 *   **gateway を外せば元の直書きに戻る**（`throughGateway(ctx, fact, () => f())` を
 *   `f()` に戻すだけ）。段の境界を「止めても壊れない」ところに置く、の実装である。
 *
 * ─ 守る 3 つ ─
 *
 *   (1) 既存の挙動を 1 つも変えない
 *       元の書き込みの返り値・例外はそのまま素通しする。L0 への追記は
 *       **決して throw しない**（失敗しても元の経路は成功のまま）。
 *   (2) 出来事を捨てない（E1）
 *       未知の event_type でも 400 にせず schema_ok = false で保存する。
 *   (3) 無言で捨てない（T-12）
 *       元の書き込みが skip した理由・失敗した理由を L0 の payload と 1 行ログに
 *       必ず残す。「未連携だから記録しなかった」が数えられる状態になる。
 *
 * ─ PII ─
 *   payload に生の LINE userId・メール・会話本文を入れない。呼ぶ側が入れないように
 *   するのではなく、**入れる場所が無い形**にしてある（identifier は subject の解決に
 *   使うだけで payload には落ちない）。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isKnownChannel,
  isKnownEventType,
  isWellFormedChannel,
  isWellFormedEventType,
  isWellFormedPayload,
} from "./event-vocabulary";
import { resolveOrIssueSubject, type ObservedIdentifier } from "./subjects";

export const CUSTOMER_EVENTS_TABLE = "customer_events";

/** L0 に積む 1 件の事実。 */
export interface CustomerFact {
  /** L0 の型名。既知でなくてよい（未知なら schema_ok = false で入る）。 */
  eventType: string;
  /** "line" / "web" / "shopify" 等。既知でなくてよい。 */
  channel: string;
  /** 誰の出来事か。ここから主体を引く（無ければ発行する）。 */
  identifier: ObservedIdentifier;
  /**
   * 同じ出来事を 2 回書いても 1 行にするための識別子。
   * 呼ぶ側が **決定的に** 組み立てる（同じ出来事なら何度計算しても同じ文字列）。
   * 生の識別子は入れない（E5）。作り方は docs/cdp-events-gateway-contract.md が正本。
   */
  dedupe: string;
  /** どの経路が書いたか（slug）。 */
  source: string;
  /** 起きた時刻（ISO8601）。省略時は now。 */
  occurredAt?: string;
  /** 出来事の中身。PII を入れない。 */
  payload?: Record<string, unknown>;
}

/** 元の書き込みが何をしたか。void を返す経路は "ok" とみなす。 */
export type LegacyOutcome =
  | { status: "ok" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/** L0 への取り込み結果。 */
export interface IntakeResult {
  /** 積めたか。 */
  stored: boolean;
  /** 既知の語彙だったか（false でも stored は true になりうる = E1）。 */
  schemaOk: boolean;
  /** 積めなかった理由（stored=false のときだけ）。 */
  reason?: string;
  /** 解決・発行された主体。 */
  subjectId?: string;
  /** この呼び出しで新しく発行したか。 */
  subjectIssued?: boolean;
}

/** 冪等キーの最大長（041 の CHECK と揃える）。 */
const IDEMPOTENCY_MAX = 200;

/**
 * 冪等キーを組み立てる。
 *
 * 形: `<source>:<subject_id>:<event_type>:<dedupe>`
 *
 * subject_id を使うのは **生の識別子を鍵に入れないため**（E5）。subject_id は
 * 不透明な 26 文字なので、この列を見ても誰のことか分からない。
 */
export function buildIdempotencyKey(
  source: string,
  subjectId: string,
  eventType: string,
  dedupe: string,
): string {
  const raw = `${source}:${subjectId}:${eventType}:${dedupe}`;
  return raw.length <= IDEMPOTENCY_MAX ? raw : raw.slice(0, IDEMPOTENCY_MAX);
}

/**
 * L0 に 1 件積む。**決して throw しない。**
 *
 * 呼ぶ側の応答を止めないことが最優先なので、失敗は 1 行ログにして戻る
 * （flow-events / recordBehaviorEvent と同じ作法）。
 */
export async function recordCustomerEvent(
  supabase: SupabaseClient,
  fact: CustomerFact,
  legacy: LegacyOutcome = { status: "ok" },
): Promise<IntakeResult> {
  try {
    if (!isWellFormedEventType(fact.eventType)) {
      // 形が壊れている（語彙の未知とは別）。**捨てたことを必ず言う**。
      return countedSkip(fact, "event_type_malformed", legacy);
    }
    if (!isWellFormedChannel(fact.channel)) {
      return countedSkip(fact, "channel_malformed", legacy);
    }
    if (typeof fact.dedupe !== "string" || fact.dedupe.length === 0) {
      return countedSkip(fact, "dedupe_missing", legacy);
    }

    const subject = await resolveOrIssueSubject(supabase, fact.identifier, fact.source);
    if (subject.subjectId === null) {
      return countedSkip(fact, `subject_unavailable:${subject.reason}`, legacy);
    }

    // Stage 4: 語彙が既知であることに加えて、**L1 を動かす出来事は payload の形も見る**。
    //   形が読めない行を L1 が畳むと、壊れた入力が静かに解釈へ混ざる（046 の畳み手は
    //   schema_ok = true の行だけを畳むので、ここで false を立てれば入らない）。
    //   捨てはしない — 保存はして schema_ok = false を立てるだけ（E1）。
    const schemaOk =
      isKnownEventType(fact.eventType) &&
      isKnownChannel(fact.channel) &&
      isWellFormedPayload(fact.eventType, fact.payload);
    const row = {
      subject_id: subject.subjectId,
      event_type: fact.eventType,
      channel: fact.channel,
      schema_ok: schemaOk,
      occurred_at: fact.occurredAt ?? new Date().toISOString(),
      source: fact.source,
      idempotency_key: buildIdempotencyKey(
        fact.source,
        subject.subjectId,
        fact.eventType,
        fact.dedupe,
      ),
      payload: {
        ...(fact.payload ?? {}),
        // 元の書き込みがどうなったか。**skip を無言にしないための列**（T-12）。
        legacy_write: legacy,
      },
    };

    const { error } = await supabase.from(CUSTOMER_EVENTS_TABLE).insert(row);
    if (error) {
      // 冪等キーの衝突（同じ出来事の 2 回目）は **正常**。二重加算が構造的に
      // 止まった、という結果そのものなので、失敗として数えない。
      if (isDuplicateKey(error)) {
        return {
          stored: false,
          schemaOk,
          reason: "duplicate_idempotency_key",
          subjectId: subject.subjectId,
          subjectIssued: subject.issued,
        };
      }
      console.warn(
        "[cdp/gateway] L0 insert failed (non-blocking):",
        JSON.stringify({ source: fact.source, event_type: fact.eventType, reason: error.message }),
      );
      return { stored: false, schemaOk, reason: "insert_failed", subjectId: subject.subjectId };
    }

    if (!schemaOk) {
      // E1: 捨ててはいないが、語彙から漏れたことは言う。
      console.warn(
        "[cdp/gateway] unknown vocabulary stored (schema_ok=false):",
        JSON.stringify({ source: fact.source, event_type: fact.eventType, channel: fact.channel }),
      );
    }

    return {
      stored: true,
      schemaOk,
      subjectId: subject.subjectId,
      subjectIssued: subject.issued,
    };
  } catch (err) {
    console.warn(
      "[cdp/gateway] unexpected error (non-blocking):",
      err instanceof Error ? err.message : String(err),
    );
    return { stored: false, schemaOk: false, reason: "unexpected_error" };
  }
}

/**
 * 既存の書き込みを透過で通しつつ、同じ出来事を L0 にも積む。
 *
 * 元の書き込みの返り値・例外はそのまま素通しする。**gateway を外すときは
 * `throughGateway(sb, fact, () => f())` を `f()` に戻すだけでよい。**
 *
 * @param legacyWrite 元の直書き。`LegacyOutcome` を返せば skip 理由が L0 に残る。
 */
export async function throughGateway<T>(
  supabase: SupabaseClient,
  fact: CustomerFact,
  legacyWrite: () => Promise<T>,
  mapOutcome?: (result: T) => LegacyOutcome,
): Promise<T> {
  let result: T;
  try {
    result = await legacyWrite();
  } catch (err) {
    // 元の経路が落ちたことも出来事である（落ちたこと自体を捨てない）。
    await recordCustomerEvent(supabase, fact, {
      status: "failed",
      reason: err instanceof Error ? err.name : "non_error_thrown",
    });
    throw err;
  }

  await recordCustomerEvent(supabase, fact, mapOutcome ? mapOutcome(result) : asOutcome(result));
  return result;
}

/**
 * 「LINE / Web のどちらの人か」から identity_edges の kind を決める。
 *
 * 既存の 5 経路はどれも `channel: "line" | "web"` で人を区別しているので、
 * 変換をここ 1 か所に置く（各経路が自前で分岐すると、増えたときにずれる）。
 */
export function identifierForChannel(
  channel: string,
  userRef: string,
): ObservedIdentifier {
  return channel === "web"
    ? { kind: "web_session_id", value: userRef }
    : { kind: "line_messaging_uid", value: userRef };
}

/** 元の書き込みの返り値を LegacyOutcome に読む（void は "ok"）。 */
function asOutcome(result: unknown): LegacyOutcome {
  if (result && typeof result === "object" && "status" in result) {
    const status = (result as { status?: unknown }).status;
    if (status === "skipped" || status === "failed") {
      const reason = (result as { reason?: unknown }).reason;
      return { status, reason: typeof reason === "string" ? reason : "unspecified" };
    }
    if (status === "ok") return { status: "ok" };
  }
  return { status: "ok" };
}

/**
 * 積めなかったことを **数えられる形で** 残す。
 *
 * 無言 return を作らないための唯一の出口。ここを通らずに戻る枝を作らないこと。
 */
function countedSkip(
  fact: CustomerFact,
  reason: string,
  legacy: LegacyOutcome,
): IntakeResult {
  console.warn(
    "[cdp/gateway] fact not stored:",
    JSON.stringify({
      source: fact.source,
      event_type: fact.eventType,
      channel: fact.channel,
      reason,
      legacy_write: legacy.status,
    }),
  );
  return { stored: false, schemaOk: false, reason };
}

/** PostgREST が返す一意制約違反（23505）か。 */
function isDuplicateKey(error: { code?: string; message?: string }): boolean {
  if (error.code === "23505") return true;
  const m = error.message ?? "";
  return m.includes("duplicate key") || m.includes("23505");
}
