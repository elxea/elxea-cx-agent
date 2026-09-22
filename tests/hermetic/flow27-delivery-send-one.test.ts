/**
 * ハーメティック — 1 件指定送信（段1-A）が「送ってはいけないものを送らない」こと
 *
 * ─ なぜ要るか ─
 *
 *   ここは **外部（LINE 公式アカウントの友だち全員）へ出ていく唯一の口**である。
 *   間違えたときの取り消しが効かない種類の処理なので、止まるべき条件はテストで固定する。
 *   プラン v6.2 §4-2 / §4-3 / §7-6 / §7-7 と失敗シナリオ N-03 / N-06 / N-07 / N-08 / N-12 / N-15。
 *
 * ─ 何を機械に留めるか ─
 *
 *   1. 判定が承認でない / 判定行の最終編集者が承認者本人でない → 送らない
 *   2. 最終編集者のメール解決が一時的に失敗したら「無効」ではなく「保留」(N-03)
 *   3. 承認後に本文・画像・配信対象が変わったら送らない（指紋に配信対象が入っている）
 *   4. 対象人数が承認時から +10% を超えて増えたら送らない (N-12)
 *   5. 無料枠の残りが足りなければ送らない
 *   6. 送信前に予約を取る。別予約の二重到達は拒否、同一予約の二重到達は **再送しない** (N-06 / N-07)
 *   7. すべての送信要求に X-Line-Retry-Key が載る (N-08)
 *   8. 送信が失敗したら Sent と記録しない (N-15)
 *
 * ⚠ 実ネットワーク不使用・実送信ゼロ。LINE 送信ポートも Notion もすべて fake を注入する。
 */

import { describe, expect, it } from "vitest";
import {
  sendOneDelivery,
  audienceCountWithinTolerance,
  httpStatusFor,
  type SendOneDeps,
  type SendOneRequest,
  type ReservationClaim,
} from "../../src/lib/delivery-send-one";
import { computeContentHash } from "../../src/lib/content-hash";
import { audienceFingerprintKey, parseAudience } from "../../src/lib/delivery-audience";
import { deterministicRetryKey, type SendOutcome } from "../../src/lib/line-messages";
import { isApprovedJudgment } from "../../src/lib/delivery-approval-task";
import { RetryableApprovalError } from "../../src/lib/delivery-approval-task";
import type { DeliveryPage, DeliveryResult } from "../../src/lib/delivery-repository";

const OWNER = "owner@example.test";
const PAGE_ID = "page-hermetic-0001";
const TASK_ID = "task-hermetic-0001";
const RESERVATION = "rsv-hermetic-0001";
const BODY = "テスト本文（実送信ゼロ）";

/** 本文だけの text 行（画像なし・全員配信）。 */
function makePage(over: Partial<DeliveryPage> = {}): DeliveryPage {
  return {
    id: PAGE_ID,
    title: "テスト配信",
    status: "Approved",
    audienceRaw: "全員",
    format: "text",
    body: BODY,
    imageSourceUrls: [],
    imageCount: 0,
    scheduledStart: null,
    sent: false,
    contentHash: null,
    estimate: 100,
    assignees: ["u-author"],
    approvers: ["u-approver"],
    lastEditedTime: "2026-09-22T00:00:00.000Z",
    ...over,
  };
}

/** 「全員 / 本文そのまま / 画像なし」の正しい指紋。 */
async function validHash(audienceRaw = "全員", body = BODY): Promise<string> {
  const spec = parseAudience(audienceRaw);
  if (!spec) throw new Error("test fixture: audience 不正");
  return computeContentHash({
    format: "text",
    body,
    imageUrls: [],
    audience: audienceFingerprintKey(spec),
  });
}

interface Recorded {
  results: DeliveryResult[];
  errors: string[];
  statuses: string[];
  sends: Array<{ kind: "broadcast" | "multicast"; retryKey?: string }>;
  claims: number;
  finishes: Array<{ sendState: string; sentCount: number }>;
}

interface FakeOptions {
  page?: Partial<DeliveryPage>;
  judgment?: string | null;
  editorId?: string | null;
  editorEmail?: string | null;
  emailThrows?: Error;
  taskThrows?: Error;
  ownerEmail?: string | null;
  audienceCount?: number;
  confirmed?: number;
  apiUsage?: number;
  claim?: ReservationClaim;
  sendOutcomes?: SendOutcome[];
}

/** 既定で「送れる」状態の deps を組み、必要な箇所だけ壊して分岐を見る。 */
async function makeDeps(
  opts: FakeOptions = {},
): Promise<{ deps: SendOneDeps; rec: Recorded }> {
  const page = makePage({
    contentHash: await validHash(opts.page?.audienceRaw ?? "全員"),
    ...opts.page,
  });
  const rec: Recorded = {
    results: [],
    errors: [],
    statuses: [],
    sends: [],
    claims: 0,
    finishes: [],
  };
  const outcomes = opts.sendOutcomes ?? [
    { ok: true, deliveredRecipients: opts.audienceCount ?? 100, partial: false, requestId: "req-1" },
  ];
  let sendCall = 0;

  const deps: SendOneDeps = {
    repo: {
      fetchPage: async () => page,
      setStatus: async (_id, status) => {
        rec.statuses.push(status);
      },
      writeResult: async (_id, result) => {
        rec.results.push(result);
      },
      writeError: async (_id, reason) => {
        rec.errors.push(reason);
      },
    },
    reservation: {
      claim: async () => {
        rec.claims += 1;
        return opts.claim ?? { kind: "claimed" };
      },
      finish: async (input) => {
        rec.finishes.push({ sendState: input.sendState, sentCount: input.sentCount });
      },
    },
    confirmedConsumption: async () => opts.confirmed ?? 0,
    consumption: async () => ({ ok: true, totalUsage: opts.apiUsage ?? 0 }),
    approvalTask: {
      fetchTask: async () => {
        if (opts.taskThrows) throw opts.taskThrows;
        return {
          judgment: opts.judgment === undefined ? "承認" : opts.judgment,
          lastEditedById: opts.editorId === undefined ? "u-owner" : opts.editorId,
          lastEditedTime: "2026-09-22T00:00:00.000Z",
        };
      },
      resolveUserEmail: async () => {
        if (opts.emailThrows) throw opts.emailThrows;
        return opts.editorEmail === undefined ? OWNER : opts.editorEmail;
      },
    },
    ownerEmail: opts.ownerEmail === undefined ? OWNER : (opts.ownerEmail ?? undefined),
    resolveTargets: async () => ({
      kind: "broadcast",
      estimatedRecipients: opts.audienceCount ?? 100,
    }),
    sender: {
      broadcast: async (_m, _n, _u, retryKey) => {
        rec.sends.push({ kind: "broadcast", retryKey });
        return outcomes[Math.min(sendCall++, outcomes.length - 1)];
      },
      multicast: async (_b, _m, _u, retryKey) => {
        rec.sends.push({ kind: "multicast", retryKey });
        return outcomes[Math.min(sendCall++, outcomes.length - 1)];
      },
    },
    now: () => new Date("2026-09-22T05:00:00.000Z"),
    imageUrlsFor: () => [],
    // 実効上限を小さくして残枠の分岐を見やすくする（既定は cap 200 / headroom 10）。
    guardOptions: { cap: 200, safetyHeadroom: 10 },
  };
  return { deps, rec };
}

const req: SendOneRequest = {
  pageId: PAGE_ID,
  approvalRef: {
    taskPageId: TASK_ID,
    approvedEditorEmail: OWNER,
    approvedEditedTime: "2026-09-22T00:00:00.000Z",
    approvedAudienceCount: 100,
  },
  reservationId: RESERVATION,
};

describe("1 件指定送信: 正常系（送るときは 1 回だけ・記録まで通る）", () => {
  it("承認・指紋・人数・残枠がすべて通れば送り、Sent を記録する", async () => {
    const { deps, rec } = await makeDeps();
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("sent");
    expect(res.sentCount).toBe(100);
    expect(rec.sends).toHaveLength(1);
    expect(rec.results).toHaveLength(1);
    expect(rec.results[0].status).toBe("Sent");
    expect(httpStatusFor(res)).toBe(200);
  });

  it("claim は送信より前に取る（claim-before-send）", async () => {
    const { deps, rec } = await makeDeps();
    await sendOneDelivery(deps, req);
    // claim が 1 回・送信が 1 回で、claim 無しの送信は起こらない。
    expect(rec.claims).toBe(1);
    expect(rec.finishes).toEqual([{ sendState: "sent", sentCount: 100 }]);
  });

  it("すべての送信要求に X-Line-Retry-Key が載る（予約 ID から決定的・N-08）", async () => {
    const { deps, rec } = await makeDeps();
    await sendOneDelivery(deps, req);
    const expected = await deterministicRetryKey(RESERVATION);
    expect(rec.sends[0].retryKey).toBe(expected);
    // UUID 形（LINE が要求する形式）であること。
    expect(expected).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // 同じ予約 ID なら常に同じ鍵（乱数でない）。
    expect(await deterministicRetryKey(RESERVATION)).toBe(expected);
    expect(await deterministicRetryKey("other")).not.toBe(expected);
  });
});

describe("1 件指定送信: 承認の確認（判定行・第二の防御）", () => {
  it("判定が承認でなければ送らない", async () => {
    const { deps, rec } = await makeDeps({ judgment: "却下" });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("rejected");
    expect(res.code).toBe("judgment_not_approved");
    expect(rec.sends).toHaveLength(0);
    expect(rec.errors.join()).toContain("判定が承認ではない");
  });

  it("判定行の最終編集者が承認者本人でなければ送らない", async () => {
    const { deps, rec } = await makeDeps({ editorEmail: "someone-else@example.test" });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("editor_mismatch");
    expect(rec.sends).toHaveLength(0);
  });

  it("メール解決の一時失敗は「無効」ではなく「保留（再試行可）」(N-03)", async () => {
    const { deps, rec } = await makeDeps({
      emailThrows: new RetryableApprovalError("Notion 429"),
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("retryable");
    expect(res.code).toBe("email_lookup_retryable");
    expect(httpStatusFor(res)).toBe(503);
    expect(rec.sends).toHaveLength(0);
    // 保留なので「無効」の記録も残さない（承認を殺さない）。
    expect(rec.errors).toHaveLength(0);
  });

  it("メールが空（capability 不足）は無効に倒す", async () => {
    const { deps } = await makeDeps({ editorEmail: null });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("email_empty");
  });

  it("照合メールが未設定なら送らない（既定値を持たない・N-05）", async () => {
    const { deps, rec } = await makeDeps({ ownerEmail: null });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("owner_email_unset");
    expect(rec.sends).toHaveLength(0);
  });

  it("配信DB行が Approved でなければ送らない / 送信済みは 409", async () => {
    const draft = await makeDeps({ page: { status: "Draft" } });
    expect((await sendOneDelivery(draft.deps, req)).code).toBe("row_not_approved");

    const sent = await makeDeps({ page: { sent: true } });
    const res = await sendOneDelivery(sent.deps, req);
    expect(res.code).toBe("row_already_sent");
    expect(httpStatusFor(res)).toBe(409);
    expect(sent.rec.sends).toHaveLength(0);
  });

  it("isApprovedJudgment: 「未承認」「承認待ち」は承認ではない", () => {
    expect(isApprovedJudgment("承認")).toBe(true);
    expect(isApprovedJudgment(" 承認 ")).toBe(true);
    expect(isApprovedJudgment("未承認")).toBe(false);
    expect(isApprovedJudgment("承認待ち")).toBe(false);
    expect(isApprovedJudgment("却下")).toBe(false);
    expect(isApprovedJudgment("修正して")).toBe(false);
    expect(isApprovedJudgment(null)).toBe(false);
  });
});

describe("1 件指定送信: 指紋（本文・画像・配信対象）", () => {
  it("承認後に本文が変わったら送らない", async () => {
    const { deps, rec } = await makeDeps({
      page: { contentHash: await validHash("全員", "別の本文") },
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("fingerprint_mismatch");
    expect(rec.sends).toHaveLength(0);
  });

  it("承認後に配信対象が変わったら送らない（指紋に配信対象が入っている）", async () => {
    // 承認時は「癒し」で pin されたのに、いま行は「全員」になっている。
    const { deps, rec } = await makeDeps({
      page: {
        contentHash: await computeContentHash({
          format: "text",
          body: BODY,
          imageUrls: [],
          audience: "persona:serenity",
        }),
      },
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("fingerprint_mismatch");
    expect(rec.sends).toHaveLength(0);
  });

  it("配信対象を含まない旧形式の指紋は受け付けない（後方互換を持たない）", async () => {
    const legacy = await computeContentHash({
      format: "text",
      body: BODY,
      imageUrls: [],
      // 旧形式は audience を持たなかった。空文字で近似しても一致しないことを固定する。
      audience: "",
    });
    const { deps } = await makeDeps({ page: { contentHash: legacy } });
    expect((await sendOneDelivery(deps, req)).code).toBe("fingerprint_mismatch");
  });

  it("承認 pin を通っていない（ハッシュ無し）行は送らない", async () => {
    const { deps } = await makeDeps({ page: { contentHash: null } });
    expect((await sendOneDelivery(deps, req)).code).toBe("fingerprint_missing");
  });
});

describe("1 件指定送信: 人数と無料枠", () => {
  it("対象人数が承認時から +10% を超えて増えたら送らない (N-12)", async () => {
    const { deps, rec } = await makeDeps({ audienceCount: 111 });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("audience_count_grew");
    expect(res.audienceCount).toBe(111);
    expect(rec.sends).toHaveLength(0);
  });

  it("+10% ちょうどは送る（境界）", async () => {
    const { deps, rec } = await makeDeps({ audienceCount: 110 });
    expect((await sendOneDelivery(deps, req)).status).toBe("sent");
    expect(rec.sends).toHaveLength(1);
  });

  it("台帳の残枠を超えたら送らない（実効 190）", async () => {
    // 当月すでに 150 通使っている → 残 40 通。対象 100 通は通さない。
    const { deps, rec } = await makeDeps({ confirmed: 150 });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("ledger_exhausted");
    expect(res.ledgerRemaining).toBe(40);
    expect(rec.sends).toHaveLength(0);
  });

  it("LINE の当月消費が取れないときは保留（残枠を判定できない）", async () => {
    const { deps, rec } = await makeDeps();
    deps.consumption = async () => ({ ok: false });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("retryable");
    expect(res.code).toBe("consumption_unavailable");
    expect(rec.sends).toHaveLength(0);
  });

  it("audienceCountWithinTolerance: 承認時人数 0 は基準にならない", () => {
    expect(audienceCountWithinTolerance(100, 110, 0.1)).toBe(true);
    expect(audienceCountWithinTolerance(100, 111, 0.1)).toBe(false);
    expect(audienceCountWithinTolerance(0, 0, 0.1)).toBe(false);
  });
});

describe("1 件指定送信: 二重送信の防止（claim・冪等）", () => {
  it("別の予約が既に確保していれば 409 で拒否（N-07）", async () => {
    const { deps, rec } = await makeDeps({
      claim: {
        kind: "duplicate",
        sameReservation: false,
        sendState: "sending",
        sentCount: null,
      },
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("claim_conflict");
    expect(httpStatusFor(res)).toBe(409);
    expect(rec.sends).toHaveLength(0);
  });

  it("同一 reservationId の二重到達は再送せず前回の結果を返す（冪等・N-06）", async () => {
    const { deps, rec } = await makeDeps({
      claim: {
        kind: "duplicate",
        sameReservation: true,
        sendState: "sent",
        sentCount: 79,
      },
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("sent");
    expect(res.code).toBe("idempotent_sent");
    expect(res.sentCount).toBe(79);
    expect(httpStatusFor(res)).toBe(200);
    expect(rec.sends).toHaveLength(0);
    expect(rec.results).toHaveLength(0);
  });

  it("同一予約が「送信中」のまま残っていても再送しない（滞留は別経路）", async () => {
    const { deps, rec } = await makeDeps({
      claim: {
        kind: "duplicate",
        sameReservation: true,
        sendState: "sending",
        sentCount: null,
      },
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("claim_in_flight");
    expect(httpStatusFor(res)).toBe(409);
    expect(rec.sends).toHaveLength(0);
  });

  it("同一予約の前回が失敗なら自動再送しない（E-04 / N-06）", async () => {
    const { deps, rec } = await makeDeps({
      claim: {
        kind: "duplicate",
        sameReservation: true,
        sendState: "failed",
        sentCount: null,
      },
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("failed");
    expect(res.code).toBe("idempotent_failed");
    expect(rec.sends).toHaveLength(0);
  });
});

describe("1 件指定送信: 送信失敗の扱い（Sent と誤記録しない・N-15）", () => {
  it("送信が全失敗なら Failed を記録し、Sent にしない", async () => {
    const { deps, rec } = await makeDeps({
      sendOutcomes: [
        { ok: false, deliveredRecipients: 0, partial: false, error: "broadcast 500" },
      ],
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("failed");
    expect(res.code).toBe("send_failed");
    expect(res.sentCount).toBe(0);
    expect(rec.results).toHaveLength(1);
    expect(rec.results[0].status).toBe("Failed");
    expect(rec.results.some((r) => r.status === "Sent")).toBe(false);
    expect(rec.finishes).toEqual([{ sendState: "failed", sentCount: 0 }]);
  });

  it("失敗は同一実行内で最大 2 回まで再試行し、鍵は変えない（E-02 / N-08）", async () => {
    const { deps, rec } = await makeDeps({
      sendOutcomes: [
        { ok: false, deliveredRecipients: 0, partial: false, error: "broadcast 500" },
        { ok: false, deliveredRecipients: 0, partial: false, error: "broadcast 500" },
        { ok: false, deliveredRecipients: 0, partial: false, error: "broadcast 500" },
      ],
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("failed");
    // 初回 + 2 回再試行 = 3 回でやめる（無限に叩かない）。
    expect(rec.sends).toHaveLength(3);
    const keys = new Set(rec.sends.map((s) => s.retryKey));
    expect(keys.size).toBe(1);
  });

  it("再試行で成功したら Sent（回数は理由に残す）", async () => {
    const { deps, rec } = await makeDeps({
      sendOutcomes: [
        { ok: false, deliveredRecipients: 0, partial: false, error: "broadcast 500" },
        { ok: true, deliveredRecipients: 100, partial: false, requestId: "req-2" },
      ],
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("sent");
    expect(rec.sends).toHaveLength(2);
    expect(rec.results[0].status).toBe("Sent");
  });

  it("全員配信で request id が取れなければ Sent にしない (N-15)", async () => {
    const { deps, rec } = await makeDeps({
      sendOutcomes: [{ ok: true, deliveredRecipients: 100, partial: false }],
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("failed");
    expect(res.code).toBe("send_unconfirmed");
    expect(rec.results[0].status).toBe("Failed");
    // 送ってしまった可能性があるので、自動再送はしない（1 回だけ叩いて止める）。
    expect(rec.sends).toHaveLength(1);
  });
});

describe("1 件指定送信: 形式の検証（要求そのものが組み立てられないとき）", () => {
  it("必須項目が欠けた要求は 400 で拒否し、何も読まない", async () => {
    const { deps, rec } = await makeDeps();
    const res = await sendOneDelivery(deps, {
      pageId: "",
      approvalRef: req.approvalRef,
      reservationId: RESERVATION,
    });
    expect(res.code).toBe("bad_request");
    expect(httpStatusFor(res)).toBe(400);
    expect(rec.sends).toHaveLength(0);
  });

  it("判定行の取得が一時的に失敗したら保留", async () => {
    const { deps } = await makeDeps({
      taskThrows: new RetryableApprovalError("Notion 503"),
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("retryable");
    expect(res.code).toBe("task_fetch_retryable");
  });
});
