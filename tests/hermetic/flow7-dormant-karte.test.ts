/**
 * ハーメティック L1 — 動線7: 休眠再エンゲージの本文をカルテで個別最適（監査 punch-list #②-3）。
 *
 * 監査 #②-3 の是正をロードベアリングにガードする:
 *   従来「静かな一通」（dormant-reengagement.ts）は全員に generic 固定本文
 *   （DORMANT_REENGAGEMENT_MESSAGE）を送っていた。#②-3 は、その人のたまったカルテ
 *   （persona / tasteProfile.preferredCategories・会話側 core.ts / 次の一杯 #2 / 一覧 #②-2 と同じ源）を読み、
 *   好みに合う参照（カテゴリ / 味の傾き）を本文に織り込む「個別最適の一通」に変える。
 *   no-karte ユーザーは完全に従来の generic に倒れる（無回帰）。
 *
 * このフローは 2 層でガードする:
 *   (1) DI コア（runDormantReengagementWith）— fake port を注入し純粋に:
 *       - 青茶を好むカルテ（preferredCategories=["oolong"]）の候補は本文に「青茶」を含む個別最適版、
 *         カルテ無しの候補は generic そのもの、の A/B を同一実行で示す（ロードベアリング）。
 *       - 送信ゲート: sendEnabled=false（既定・DORMANT_SEND_ENABLED 相当 OFF）で実送信ゼロ・全員 dry-run。
 *       - sendEnabled=true（fake sendMessage・実ネットワーク非接触）にすると、送信経路に流れる本文が
 *         「その人の個別最適本文」であることを示す（＝送るなら個別最適・ただし実送信はしない）。
 *   (2) 本番エントリ（runDormantReengagement(env, overrides)）— モック Supabase 台帳経由で:
 *       - env に DORMANT_SEND_ENABLED を置かない＝既定 dry-run。台帳に「送るはずだった個別最適本文」を残し、
 *         LINE 送信系 API には一度も触れない（h.line.sends は空）。本番配線でも送信ゲートが握り実送信ゼロ。
 *
 * 安全: 実ネットワーク不使用（グローバルガード下）。実送信ゼロ。DORMANT_SEND_ENABLED / DELIVERY_SEND_ENABLED は
 *   テスト env に無い（assertSendDisabled が throw しないことも明示的に確認する）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { synthLineUserId } from "../lib/synthetic";
import { assertSendDisabled } from "../lib/assert-not-prod";
import {
  runDormantReengagementWith,
  runDormantReengagement,
  buildDormantBody,
  deriveDormantReferencePhrase,
  DAY_MS,
  type DormantReengagementDeps,
  type LineUserActivity,
  type DecisionRecord,
} from "../../src/lib/dormant-reengagement";
import { DORMANT_REENGAGEMENT_MESSAGE } from "../../src/lib/brand-copy";
import type { NextCupKarte } from "../../src/lib/next-cup";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

const NOW = new Date("2026-07-16T00:00:00Z");
const isoDaysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

/** 青茶を好むカルテ（preferredCategories=["oolong"]・#②-2 / #2 と同じ語彙）。 */
const OOLONG_KARTE: NextCupKarte = {
  persona: null,
  tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: [], scenePref: null },
};
/** カルテ無し（未診断・未収集）＝ generic に倒れるべき対照。 */
const EMPTY_KARTE: NextCupKarte = { persona: null, tasteProfile: null };

/** fake port で runDormantReengagementWith を純粋駆動する（実 I/O 非接触・送信は fake が捕捉）。 */
function makeDeps(opts: {
  users: LineUserActivity[];
  loadKarte?: (id: string) => Promise<NextCupKarte>;
  sendEnabled?: boolean;
}) {
  const decisions: DecisionRecord[] = [];
  const sends: Array<{ lineUserId: string; body: string; unit: string }> = [];
  const marked: string[] = [];
  const deps: DormantReengagementDeps = {
    now: NOW,
    sendEnabled: opts.sendEnabled ?? false,
    thresholdDays: 60,
    perRunCap: 20,
    loadLineUsers: async () => opts.users,
    loadRecentlySent: async () => new Set<string>(),
    loadKarte: opts.loadKarte,
    recordDecision: async (d) => {
      decisions.push(d);
    },
    claimBudget: async () => ({ ok: true }),
    sendMessage: async (lineUserId, body, unit) => {
      sends.push({ lineUserId, body, unit });
    },
    markSent: async (lineUserId) => {
      marked.push(lineUserId);
    },
  };
  return { deps, decisions, sends, marked };
}

describe("hermetic L1 — 動線7: 休眠再エンゲージの個別最適（監査 #②-3）", () => {
  it("distinct カルテ(青茶) → 個別最適本文 / カルテ無し → generic の A/B（同一 dry-run 実行・送信ゼロ）", async () => {
    const uKarte = synthLineUserId("d7ka"); // 青茶を好む
    const uPlain = synthLineUserId("d7pl"); // カルテ無し
    const users: LineUserActivity[] = [
      { lineUserId: uKarte, lastActiveAt: isoDaysAgo(90) },
      { lineUserId: uPlain, lastActiveAt: isoDaysAgo(80) },
    ];
    const kartes = new Map<string, NextCupKarte>([
      [uKarte, OOLONG_KARTE],
      [uPlain, EMPTY_KARTE],
    ]);

    const { deps, decisions, sends } = makeDeps({
      users,
      loadKarte: async (id) => kartes.get(id) ?? EMPTY_KARTE,
    });
    const r = await runDormantReengagementWith(deps);

    // 送信ゲート: 既定 dry-run。実送信ゼロ（sendMessage は 1 度も呼ばれない）。
    expect(r.sendEnabled).toBe(false);
    expect(r.sent).toBe(0);
    expect(sends.length).toBe(0);
    expect(r.dryRun).toBe(2);

    const byUser = new Map(decisions.map((d) => [d.lineUserId, d.bodyPreview]));
    const karteBody = byUser.get(uKarte) ?? "";
    const plainBody = byUser.get(uPlain) ?? "";

    // ★ break-proof（ロードベアリング）: 青茶カルテの候補は本文にその好みカテゴリ「青茶」を織り込む。
    //   buildDormantBody を generic 固定に戻すと、この 1 行が赤になる（＝個別最適配線が消えたら検知）。
    expect(karteBody).toContain("青茶");
    expect(karteBody).toContain("以前お好みだった青茶に近いお茶");
    // カルテ由来ユーザーは generic とは別本文（個別最適が効いている）。
    expect(karteBody).not.toBe(DORMANT_REENGAGEMENT_MESSAGE);
    // no-karte ユーザーは generic そのまま（無回帰・出し分けが漏れない）。
    expect(plainBody).toBe(DORMANT_REENGAGEMENT_MESSAGE);
    // A/B の核: 2 人の本文は異なる（同一実行内で個別最適が人ごとに効く）。
    expect(karteBody).not.toBe(plainBody);
  });

  it("送信ゲート ON（fake・実送信なし）: 送信経路に流れる本文が『その人の個別最適本文』になる", async () => {
    const uKarte = synthLineUserId("d7on");
    const users: LineUserActivity[] = [{ lineUserId: uKarte, lastActiveAt: isoDaysAgo(70) }];

    // sendEnabled=true でも sendMessage は fake（api.line.me には触れない）。実送信は一切発生しない。
    const { deps, sends } = makeDeps({
      users,
      loadKarte: async () => OOLONG_KARTE,
      sendEnabled: true,
    });
    const r = await runDormantReengagementWith(deps);

    expect(r.sent).toBe(1);
    expect(sends.length).toBe(1);
    // 送るなら「個別最適本文」を送る（generic ではない）。実送信は fake なので誰にも届かない。
    expect(sends[0].body).toContain("青茶");
    expect(sends[0].body).not.toBe(DORMANT_REENGAGEMENT_MESSAGE);
  });

  it("純粋: persona だけでも味の傾きを織り込む / explorer・null は generic / カテゴリは persona に優先", () => {
    // persona=sensory（コク寄り）→ 味の傾きを織り込む。
    expect(buildDormantBody({ persona: "sensory", tasteProfile: null })).toContain("コク");
    // persona=serenity（まろやかな甘み寄り）→ 甘みを織り込む。
    expect(buildDormantBody({ persona: "serenity", tasteProfile: null })).toContain("まろやかな甘み");
    // explorer（味の傾きが定まらない）・カルテ null は generic に倒れる（決めつけない・無回帰）。
    expect(buildDormantBody({ persona: "explorer", tasteProfile: null })).toBe(
      DORMANT_REENGAGEMENT_MESSAGE,
    );
    expect(buildDormantBody(null)).toBe(DORMANT_REENGAGEMENT_MESSAGE);
    // 重み優先: 明示カテゴリ（preferredCategories）は persona 傾きより強い（次の一杯 #2 と同じ思想）。
    expect(
      deriveDormantReferencePhrase({
        persona: "sensory",
        tasteProfile: { preferredCategories: ["green"], flavorPreferences: [], scenePref: null },
      }),
    ).toBe("以前お好みだった緑茶に近いお茶");
  });

  it("送信フラグ: テスト env は DORMANT_SEND_ENABLED / DELIVERY_SEND_ENABLED を立てない（assertSendDisabled が throw しない）", () => {
    expect(() => assertSendDisabled(env as unknown as Record<string, unknown>)).not.toThrow();
  });

  it("本番エントリ runDormantReengagement: 既定ゲートで個別最適本文を台帳(dry_run)に記録・実送信ゼロ", async () => {
    // 単一候補で本番配線を通す（モック Supabase の compound on_conflict は行を識別しないため、A/B は DI 層で担保し、
    // ここは「本番エントリの送信ゲート＝dry-run」「個別最適本文が実台帳へ落ちる」「実送信ゼロ」を確かめる）。
    const uKarte = synthLineUserId("d7ra"); // 青茶を好む
    const users: LineUserActivity[] = [{ lineUserId: uKarte, lastActiveAt: isoDaysAgo(95) }];

    // overrides で Firestore/実 lineUsers 走査を注入シームに差し替える（実ネットワーク非接触）。recordDecision は
    // 既定（実 upsert）を通し、モック Supabase 台帳への実書き込みを検証する。
    // sendEnabled は渡さない → env.DORMANT_SEND_ENABLED（未設定）由来で false ＝ 既定 dry-run（本番配線の送信ゲート）。
    const r = await runDormantReengagement(env, {
      now: NOW,
      loadLineUsers: async () => users,
      loadRecentlySent: async () => new Set<string>(),
      loadKarte: async () => OOLONG_KARTE,
    });

    expect(r.ok).toBe(true);
    expect(r.sendEnabled).toBe(false); // env に送信フラグ無し → 本番配線でも dry-run
    expect(r.sent).toBe(0);
    expect(r.dryRun).toBe(1);

    // 実送信ゼロ: LINE 送信系 API（api.line.me）に一度も触れていない（dry-run は sendMessage 経路に入らない）。
    expect(h.line.sends.length).toBe(0);

    // 台帳（モック Supabase）に「送るはずだった個別最適本文」が dry_run で残る。
    const rows = h.supabase.all("dormant_reengagement_log") as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.line_user_id).toBe(uKarte);
    expect(row.dry_run).toBe(true);
    expect(row.sent).toBe(false);
    expect(String(row.body_preview)).toContain("青茶"); // 本番配線でも個別最適が実台帳へ落ちる
    expect(String(row.body_preview)).not.toBe(DORMANT_REENGAGEMENT_MESSAGE);
  });
});
