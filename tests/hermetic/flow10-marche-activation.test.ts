/**
 * ハーメティック L1 — 動線10: マルシェ入口「番号未送信」活性化ナッジ（spec drift #1・監査 #1）。
 *
 * spec drift #1 の是正をロードベアリングにガードする:
 *   ジャーニーマップ §17:334 は「マルシェ入口＝最大の入口」と名指すが、袋の 5 桁番号を送らず
 *   （＝お茶カード未到達で）静かになった友だちには短期ホライズンの再喚起が無かった。本フローは
 *   「onboarding.source=marche かつ tea.card_view 無し かつ 追加から短いしきい値を過ぎ短期窓内」の
 *   友だちに、1 回だけ静かなナッジ（MARCHE_ACTIVATION_MESSAGE）を dry-run で生成する。
 *   カード到達済み（番号送信済み）・別入口・既ナッジ済みは対象外。
 *
 * このフローは 2 層でガードする:
 *   (1) DI コア（runMarcheActivationWith）— fake port を注入し純粋に:
 *       - marche 番号未送信の候補は本文 MARCHE_ACTIVATION_MESSAGE のナッジを生成、
 *         カード到達済み / 別入口(online) / 既ナッジ済み / 窓外 は生成しない、を同一実行で示す（ロードベアリング）。
 *       - 送信ゲート: sendEnabled=false（既定・MARCHE_SEND_ENABLED 相当 OFF）で実送信ゼロ・全員 dry-run。
 *       - dedup: alreadyNudged（sent=true 集合）に居る人は 2 通目を出さない（恒久 1 人 1 回）。
 *       - ledger: sendEnabled=true でも claimBudget が already_claimed を返すと budget_blocked＝実送信しない。
 *   (2) 本番エントリ（runMarcheActivation(env, overrides)）— モック Supabase 台帳経由で:
 *       - env に MARCHE_SEND_ENABLED を置かない＝既定 dry-run。台帳に「送るはずだった本文」を残し、
 *         LINE 送信系 API には一度も触れない（h.line.sends は空）。本番配線でも送信ゲートが握り実送信ゼロ。
 *
 * 安全: 実ネットワーク不使用（グローバルガード下）。実送信ゼロ。MARCHE_SEND_ENABLED は
 *   テスト env に無い（assertSendDisabled が throw しないことも明示的に確認する）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { synthLineUserId } from "../lib/synthetic";
import { assertSendDisabled } from "../lib/assert-not-prod";
import {
  runMarcheActivationWith,
  runMarcheActivation,
  selectActivationCandidates,
  DAY_MS,
  type MarcheActivationDeps,
  type MarcheUser,
  type ActivationDecisionRecord,
} from "../../src/lib/marche-activation";
import { MARCHE_ACTIVATION_MESSAGE } from "../../src/lib/brand-copy";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

const NOW = new Date("2026-07-19T00:00:00Z");
const isoDaysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * DAY_MS).toISOString();

/** marche 入口の合成ユーザーを 1 件組む。 */
function marcheUser(id: string, createdDaysAgo: number): MarcheUser {
  return { lineUserId: id, createdAt: isoDaysAgo(createdDaysAgo), source: "marche" };
}

/** fake port で runMarcheActivationWith を純粋駆動する（実 I/O 非接触・送信は fake が捕捉）。 */
function makeDeps(opts: {
  users: MarcheUser[];
  usersWithCard?: Set<string>;
  alreadyNudged?: Set<string>;
  sendEnabled?: boolean;
  claimBudget?: (id: string, unit: string) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const decisions: ActivationDecisionRecord[] = [];
  const sends: Array<{ lineUserId: string; body: string; unit: string }> = [];
  const marked: string[] = [];
  const deps: MarcheActivationDeps = {
    now: NOW,
    sendEnabled: opts.sendEnabled ?? false,
    thresholdDays: 1,
    windowDays: 14,
    perRunCap: 20,
    loadMarcheUsers: async () => opts.users,
    loadUsersWithCard: async () => opts.usersWithCard ?? new Set<string>(),
    loadAlreadyNudged: async () => opts.alreadyNudged ?? new Set<string>(),
    recordDecision: async (d) => {
      decisions.push(d);
    },
    claimBudget: opts.claimBudget ?? (async () => ({ ok: true })),
    sendMessage: async (lineUserId, body, unit) => {
      sends.push({ lineUserId, body, unit });
    },
    markSent: async (lineUserId) => {
      marked.push(lineUserId);
    },
  };
  return { deps, decisions, sends, marked };
}

describe("hermetic L1 — 動線10: マルシェ活性化ナッジ（spec drift #1）", () => {
  it("marche 番号未送信×閾値超過 → ナッジ生成 / カード到達済み・別入口(online)・窓外 → 生成しない（同一 dry-run・送信ゼロ）", async () => {
    const uNudge = synthLineUserId("ma01"); // marche・3日前・カード未到達 → ナッジ対象
    const uCard = synthLineUserId("ma02"); // marche・3日前・カード到達済み → 対象外（番号送信済み）
    const uOnline = synthLineUserId("ma03"); // online・3日前・カード未到達 → 対象外（別入口）
    const uFresh = synthLineUserId("ma04"); // marche・12h前・カード未到達 → 対象外（閾値 1 日未満）
    const uStale = synthLineUserId("ma05"); // marche・15日前・カード未到達 → 対象外（窓 14 日超・休眠に譲る）

    const users: MarcheUser[] = [
      marcheUser(uNudge, 3),
      marcheUser(uCard, 3),
      { lineUserId: uOnline, createdAt: isoDaysAgo(3), source: "online" },
      marcheUser(uFresh, 0.5),
      marcheUser(uStale, 15),
    ];

    const { deps, decisions, sends } = makeDeps({
      users,
      usersWithCard: new Set([uCard]),
    });
    const r = await runMarcheActivationWith(deps);

    // 送信ゲート: 既定 dry-run。実送信ゼロ（sendMessage は 1 度も呼ばれない）。
    expect(r.sendEnabled).toBe(false);
    expect(r.sent).toBe(0);
    expect(sends.length).toBe(0);

    const nudgedIds = decisions.map((d) => d.lineUserId);

    // ★ break-proof（ロードベアリング）: marche 番号未送信×閾値超過の候補にだけナッジが生成される。
    //   検出/選定配線が消える（例: source 判定 or card 判定 or 閾値を壊す）と、この 1 行が赤になる。
    expect(nudgedIds).toContain(uNudge);
    // 生成された本文はブランド正本の活性化ナッジ（generic・個別最適しない）。宛先も正しい。
    const byUser = new Map(decisions.map((d) => [d.lineUserId, d.bodyPreview]));
    expect(byUser.get(uNudge)).toBe(MARCHE_ACTIVATION_MESSAGE);

    // 対象外は 1 件も生成されない（カード到達済み / 別入口 / 閾値未満 / 窓外）。
    expect(nudgedIds).not.toContain(uCard);
    expect(nudgedIds).not.toContain(uOnline);
    expect(nudgedIds).not.toContain(uFresh);
    expect(nudgedIds).not.toContain(uStale);

    // 候補は uNudge の 1 件のみ・dry-run 記録 1 件。
    expect(r.candidates).toBe(1);
    expect(r.dryRun).toBe(1);
  });

  it("dedup: 既ナッジ済み(alreadyNudged=sent 済み集合)に居る人は 2 通目を出さない（恒久 1 人 1 回）", async () => {
    const u = synthLineUserId("ma10"); // marche・3日前・カード未到達だが既にナッジ送信済み
    const { deps, decisions } = makeDeps({
      users: [marcheUser(u, 3)],
      alreadyNudged: new Set([u]),
    });
    const r = await runMarcheActivationWith(deps);

    // 既ナッジ済み → 候補ゼロ・決定行ゼロ（2 通目を生成しない）。
    expect(r.candidates).toBe(0);
    expect(decisions.length).toBe(0);
    expect(decisions.map((d) => d.lineUserId)).not.toContain(u);
  });

  it("送信ゲート ON（fake・実送信なし）: 送信経路に流れる本文が MARCHE_ACTIVATION_MESSAGE になる", async () => {
    const u = synthLineUserId("ma20");
    // sendEnabled=true でも sendMessage は fake（api.line.me には触れない）。実送信は一切発生しない。
    const { deps, sends, marked } = makeDeps({
      users: [marcheUser(u, 3)],
      sendEnabled: true,
    });
    const r = await runMarcheActivationWith(deps);

    expect(r.sent).toBe(1);
    expect(sends.length).toBe(1);
    expect(sends[0].lineUserId).toBe(u);
    expect(sends[0].body).toBe(MARCHE_ACTIVATION_MESSAGE); // 送るなら活性化ナッジ本文。ただし fake で誰にも届かない。
    expect(marked).toContain(u); // sent 記録も走る。
  });

  it("ledger 再利用: claimBudget が already_claimed を返すと budget_blocked＝実送信しない（message-ledger の 2 重送信防止）", async () => {
    const u = synthLineUserId("ma30");
    const { deps, sends } = makeDeps({
      users: [marcheUser(u, 3)],
      sendEnabled: true,
      // message-ledger.guardAndClaim が (notion_page_id, month) 一意で 2 重 claim を拒否する挙動を模す。
      claimBudget: async () => ({ ok: false, reason: "already_claimed" }),
    });
    const r = await runMarcheActivationWith(deps);

    expect(r.sent).toBe(0);
    expect(r.budgetBlocked).toBe(1);
    expect(sends.length).toBe(0); // 予算/台帳ガードで送信経路に入らない。
  });

  it("純粋 selectActivationCandidates: source=marche・card 未到達・閾値内窓内のみ・createdAt 昇順で cap 切り", () => {
    const a = synthLineUserId("map1"); // marche 5日前 → 対象
    const b = synthLineUserId("map2"); // marche 2日前 → 対象
    const c = synthLineUserId("map3"); // marche 3日前だがカード到達 → 除外
    const users: MarcheUser[] = [marcheUser(a, 5), marcheUser(b, 2), marcheUser(c, 3)];
    const got = selectActivationCandidates(
      users,
      new Set([c]), // usersWithCard
      new Set<string>(), // alreadyNudged
      NOW,
      1, // thresholdDays
      14, // windowDays
      20, // cap
    );
    // createdAt 昇順（古い順）: a(5日前) → b(2日前)。c はカード到達で除外。
    expect(got.map((x) => x.lineUserId)).toEqual([a, b]);

    // cap=1 で先頭（最も古い a）だけ残る。
    const capped = selectActivationCandidates(users, new Set([c]), new Set(), NOW, 1, 14, 1);
    expect(capped.map((x) => x.lineUserId)).toEqual([a]);
  });

  it("送信フラグ: テスト env は MARCHE_SEND_ENABLED を立てない（assertSendDisabled が throw しない）", () => {
    expect(() => assertSendDisabled(env as unknown as Record<string, unknown>)).not.toThrow();
    // 活性化ゲートも OFF であることを明示（実送信の芽を摘む）。
    expect((env as unknown as Record<string, unknown>).MARCHE_SEND_ENABLED).not.toBe("true");
  });

  it("本番エントリ runMarcheActivation: 既定ゲートでナッジ本文を台帳(dry_run)に記録・実送信ゼロ", async () => {
    const u = synthLineUserId("ma40"); // marche・4日前・カード未到達
    // overrides で Firestore/実 lineUsers 走査・flow_events・dedup 読取を注入シームに差し替える（実ネットワーク非接触）。
    // recordDecision は既定（実 upsert）を通し、モック Supabase 台帳への実書き込みを検証する。
    // sendEnabled は渡さない → env.MARCHE_SEND_ENABLED（未設定）由来で false ＝ 既定 dry-run（本番配線の送信ゲート）。
    const r = await runMarcheActivation(env, {
      now: NOW,
      loadMarcheUsers: async () => [marcheUser(u, 4)],
      loadUsersWithCard: async () => new Set<string>(),
      loadAlreadyNudged: async () => new Set<string>(),
    });

    expect(r.ok).toBe(true);
    expect(r.sendEnabled).toBe(false); // env に送信フラグ無し → 本番配線でも dry-run
    expect(r.sent).toBe(0);
    expect(r.dryRun).toBe(1);

    // 実送信ゼロ: LINE 送信系 API（api.line.me）に一度も触れていない（dry-run は sendMessage 経路に入らない）。
    expect(h.line.sends.length).toBe(0);

    // 台帳（モック Supabase）に「送るはずだった本文」が dry_run で残る。
    const rows = h.supabase.all("marche_activation_log") as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.line_user_id).toBe(u);
    expect(row.dry_run).toBe(true);
    expect(row.sent).toBe(false);
    expect(String(row.body_preview)).toBe(MARCHE_ACTIVATION_MESSAGE); // 本番配線でも正本ナッジが実台帳へ落ちる
  });
});
