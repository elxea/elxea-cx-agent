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
  collectRequestIds,
  httpStatusFor,
  type SendOneDeps,
  type SendOneRequest,
  type ReservationClaim,
} from "../../src/lib/delivery-send-one";
import { computeContentHash } from "../../src/lib/content-hash";
import { audienceFingerprintKey, parseAudience } from "../../src/lib/delivery-audience";
import {
  acceptedRequestIdFrom,
  batchRetryKey,
  chunkForMulticast,
  createLineSender,
  deterministicRetryKey,
  LINE_ACCEPTED_REQUEST_ID_HEADER,
  LINE_REQUEST_ID_HEADER,
  requestIdFrom,
  type SendOutcome,
} from "../../src/lib/line-messages";
import {
  createSupabaseReservationPort,
  formatRequestIdsNote,
} from "../../src/lib/delivery-runtime";
import { RECONCILE_PENDING_FILTER } from "../../src/lib/broadcast-reconcile";
import {
  DEFAULT_APPROVAL_JUDGMENTS,
  isApprovedJudgment,
  parseApprovalJudgments,
} from "../../src/lib/delivery-approval-task";
import {
  ALL_TASKS_DATABASE_ID,
  ApprovalConfigError,
  RetryableApprovalError,
} from "../../src/lib/delivery-approval-task";
import type { DeliveryChannel } from "../../src/lib/delivery-channel";
import type { DeliveryPage, DeliveryResult } from "../../src/lib/delivery-repository";
import type { ResolvedTargets } from "../../src/lib/target-resolver";

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
  /** finish に渡った入力の全体（鍵・出所の検証用）。 */
  finishInputs: Array<Parameters<SendOneDeps["reservation"]["finish"]>[0]>;
}

interface FakeOptions {
  page?: Partial<DeliveryPage>;
  judgment?: string | null;
  editorId?: string | null;
  editorEmail?: string | null;
  emailThrows?: Error;
  taskThrows?: Error;
  taskDetails?: string;
  ownerEmail?: string | null;
  audienceCount?: number;
  confirmed?: number;
  apiUsage?: number;
  claim?: ReservationClaim;
  sendOutcomes?: SendOutcome[];
  /** 対象解決の結果（既定は全員配信）。「社内」等の宛先列挙は multicast を渡す。 */
  targets?: ResolvedTargets;
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
    finishInputs: [],
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
        rec.finishInputs.push(input);
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
          parentDatabaseId: ALL_TASKS_DATABASE_ID,
          parentDataSourceId: null,
          details:
            opts.taskDetails ??
            `理由をここに\n要約\napproval_key=elxea-line-delivery:staging:${PAGE_ID} 対象: `,
          targetUrl: "",
        };
      },
      resolveUserEmail: async () => {
        if (opts.emailThrows) throw opts.emailThrows;
        return opts.editorEmail === undefined ? OWNER : opts.editorEmail;
      },
    },
    ownerEmail: opts.ownerEmail === undefined ? OWNER : (opts.ownerEmail ?? undefined),
    resolveTargets: async () =>
      opts.targets ?? {
        kind: "broadcast",
        estimatedRecipients: opts.audienceCount ?? 100,
      },
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

describe("1 件指定送信: 閉じたリンクの送信前検査（設計 rev2 第5章・第9章 テスト9）", () => {
  const CLOSED_BODY = "新しいお茶のご案内です。詳しくは https://elxea.com/ja/journal/new をご覧ください。";
  const OPEN_BODY =
    "新しいお茶のご案内です。お求めは https://www.amazon.co.jp/stores/page/0C75602F-4851-4957-8D54-9A17590AF63C から。お問い合わせ info@elxea.com";

  it("閉店中、閉じたリンク入りの行は送られず closed_site_link で止まる（書き換えない）", async () => {
    const { deps, rec } = await makeDeps({
      page: { body: CLOSED_BODY, contentHash: await validHash("全員", CLOSED_BODY) },
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("rejected");
    expect(res.code).toBe("closed_site_link");
    expect(httpStatusFor(res)).toBe(422);
    expect(rec.sends).toHaveLength(0);
    expect(rec.claims).toBe(0);
    expect(rec.errors.join("\n")).toContain("閉店中");
  });

  it("スキーム無しの elxea.com/ja でも止まる", async () => {
    const body = "続きは elxea.com/ja で。";
    const { deps, rec } = await makeDeps({ page: { body, contentHash: await validHash("全員", body) } });
    expect((await sendOneDelivery(deps, req)).code).toBe("closed_site_link");
    expect(rec.sends).toHaveLength(0);
  });

  it("Amazon の URL と info@elxea.com だけなら閉店中も送る", async () => {
    const { deps, rec } = await makeDeps({
      page: { body: OPEN_BODY, contentHash: await validHash("全員", OPEN_BODY) },
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.code).toBe("sent");
    expect(rec.sends).toHaveLength(1);
  });

  it("開店中は検査で止めない（閉じたリンクの判定が働かない）", async () => {
    const { deps, rec } = await makeDeps({
      page: { body: CLOSED_BODY, contentHash: await validHash("全員", CLOSED_BODY) },
    });
    const res = await sendOneDelivery({ ...deps, siteOpen: true }, req);
    expect(res.code).toBe("sent");
    expect(rec.sends).toHaveLength(1);
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

  it("承認確認用 token が未設定なら再試行しない設定エラーで止め、送らない", async () => {
    const { deps, rec } = await makeDeps({
      taskThrows: new ApprovalConfigError("approval_token_unset", "NOTION_APPROVAL_TOKEN が未設定"),
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("rejected");
    expect(res.code).toBe("approval_token_unset");
    expect(httpStatusFor(res)).toBe(422);
    expect(rec.sends).toHaveLength(0);
  });

  it("判定行が接続に共有されていない (404) なら再試行しない設定エラー", async () => {
    const { deps, rec } = await makeDeps({
      taskThrows: new ApprovalConfigError("task_not_shared", "Notion 404"),
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("rejected");
    expect(res.code).toBe("task_not_shared");
    expect(rec.sends).toHaveLength(0);
  });

  it("判定行が別の配信行の承認なら送らない (承認の使い回しを止める)", async () => {
    const { deps, rec } = await makeDeps({
      taskDetails: "approval_key=elxea-line-delivery:staging:page-hermetic-9999 対象: ",
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("rejected");
    expect(res.code).toBe("task_link_mismatch");
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

// ---------------------------------------------------------------------------
// 実 sender（createLineSender）を通す検証のための fetch 差し替え
//
// ⚠ ネットワークへは出ない。globalThis.fetch を **このテストの中だけ** 差し替え、
//   LINE の応答（成功 / 409 受理済み / 例外）を手で作って返す。
//   差し替えは finally で必ず戻す（グローバルガードの afterEach も重ねて戻す）。
// ---------------------------------------------------------------------------

interface StubCall {
  url: string;
  retryKey?: string;
  to?: string[];
}

function stubFetch(
  handler: (call: StubCall, index: number) => Response | Promise<Response>,
): { calls: StubCall[]; restore: () => void } {
  const calls: StubCall[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    let to: string[] | undefined;
    if (typeof init?.body === "string") {
      const parsed = JSON.parse(init.body) as { to?: string[] };
      to = parsed.to;
    }
    const call: StubCall = {
      url,
      retryKey: headers.get("X-Line-Retry-Key") ?? undefined,
      to,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

const TEST_CHANNEL: DeliveryChannel = {
  targetEnv: "test",
  accessToken: "hermetic-mock-token",
  fallbackFriendCount: null,
  label: "test(hermetic)",
};

describe("1 件指定送信: 再試行キーが受理済みだった場合（届いたのに Failed にしない・QA C-1）", () => {
  it("初回 fetch 例外 → 2 回目 409 受理済み → Sent を記録し sentCount が正しい", async () => {
    const { deps, rec } = await makeDeps();
    // 実 sender を使う（409 の読み方そのものを検証するため stub sender では意味がない）。
    deps.sender = createLineSender(TEST_CHANNEL);

    const stub = stubFetch((_call, index) => {
      // 1 回目: タイムアウト相当の例外。実は LINE 側では受理されていた、という状況。
      if (index === 0) throw new Error("network timeout");
      // 2 回目: 同じ再試行キーの要求が既に受理済み → 409 + 受理済み request id。
      return new Response("conflict", {
        status: 409,
        headers: { [LINE_ACCEPTED_REQUEST_ID_HEADER]: "accepted-req-9" },
      });
    });

    let res;
    try {
      res = await sendOneDelivery(deps, req);
    } finally {
      stub.restore();
    }

    // 「届いている」ので Sent。0 通や Failed にしてはいけない。
    expect(res.status).toBe("sent");
    expect(res.code).toBe("sent");
    expect(res.sentCount).toBe(100);
    // 後追いで実配信数を引く鍵は受理済み request id を採る（ここで拾わないと二度と手に入らない）。
    expect(res.requestId).toBe("accepted-req-9");
    expect(res.reason).toContain("受理済み");

    expect(rec.results).toHaveLength(1);
    expect(rec.results[0].status).toBe("Sent");
    expect(rec.results[0].consumed).toBe(100);
    expect(rec.finishes).toEqual([{ sendState: "sent", sentCount: 100 }]);

    // 送信要求は 2 回（初回 + 再試行 1 回）で、**同じ再試行キー**を使っている。
    expect(stub.calls).toHaveLength(2);
    const expectedKey = await deterministicRetryKey(RESERVATION);
    expect(stub.calls.map((c) => c.retryKey)).toEqual([expectedKey, expectedKey]);
  });

  it("409 でもヘッダが無ければ受理済みとは見なさない（本当の失敗は Failed のまま）", async () => {
    const { deps, rec } = await makeDeps();
    deps.sender = createLineSender(TEST_CHANNEL);

    const stub = stubFetch(() => new Response("conflict", { status: 409 }));
    let res;
    try {
      res = await sendOneDelivery(deps, req);
    } finally {
      stub.restore();
    }

    expect(res.status).toBe("failed");
    expect(res.code).toBe("send_failed");
    expect(res.sentCount).toBe(0);
    expect(res.requestId).toBeNull();
    expect(rec.results[0].status).toBe("Failed");
  });

  it("acceptedRequestIdFrom: 409 + ヘッダのときだけ request id を返す（純粋）", () => {
    const with409 = new Response(null, {
      status: 409,
      headers: { [LINE_ACCEPTED_REQUEST_ID_HEADER]: "req-abc" },
    });
    expect(acceptedRequestIdFrom(with409)).toBe("req-abc");
    // 200 のヘッダ付きは対象外（成功経路は x-line-request-id を読む）。
    expect(
      acceptedRequestIdFrom(
        new Response(null, {
          status: 200,
          headers: { [LINE_ACCEPTED_REQUEST_ID_HEADER]: "req-abc" },
        }),
      ),
    ).toBeNull();
    expect(acceptedRequestIdFrom(new Response(null, { status: 409 }))).toBeNull();
    expect(acceptedRequestIdFrom(new Response(null, { status: 500 }))).toBeNull();
  });
});

describe("multicast の再試行キーはバッチごとに分かれる（後半の人に届かない事故を防ぐ・QA MID-1）", () => {
  it("batchRetryKey: 決定的・バッチごとに別・0 は基底キーそのまま", async () => {
    const base = await deterministicRetryKey(RESERVATION);
    expect(await batchRetryKey(base, 0)).toBe(base);
    const k1 = await batchRetryKey(base, 1);
    const k2 = await batchRetryKey(base, 2);
    expect(k1).not.toBe(base);
    expect(k1).not.toBe(k2);
    // 決定的（再試行で鍵が変わると LINE 側の重複判定が効かない）。
    expect(await batchRetryKey(base, 1)).toBe(k1);
    // UUID 形（LINE が要求する形式）。
    expect(k1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("2 バッチの multicast は別々の鍵で送り、409 受理済みのバッチも届いた扱いにする", async () => {
    const sender = createLineSender(TEST_CHANNEL);
    const userIds = Array.from({ length: 600 }, (_v, i) => `U${String(i).padStart(4, "0")}`);
    const batches = chunkForMulticast(userIds);
    expect(batches.map((b) => b.length)).toEqual([500, 100]);

    const base = await deterministicRetryKey(RESERVATION);
    const stub = stubFetch((_call, index) =>
      index === 0
        ? new Response("{}", { status: 200 })
        : // 2 バッチ目は前回の呼び出しで受理済みだった（= 届いている）。
          new Response("conflict", {
            status: 409,
            headers: { [LINE_ACCEPTED_REQUEST_ID_HEADER]: "accepted-batch-2" },
          }),
    );

    let outcome: SendOutcome;
    try {
      outcome = await sender.multicast(
        batches,
        [{ type: "text", text: "テスト本文" }],
        undefined,
        base,
      );
    } finally {
      stub.restore();
    }

    expect(outcome.ok).toBe(true);
    expect(outcome.deliveredRecipients).toBe(600);
    expect(outcome.partial).toBe(false);
    expect(outcome.alreadyAccepted).toBe(true);
    // 1 バッチ目は x-line-request-id 無しの 200、2 バッチ目は受理済みの鍵 → 取れた鍵は 1 本。
    expect(outcome.requestIds).toEqual(["accepted-batch-2"]);
    expect(outcome.requestId).toBe("accepted-batch-2");

    expect(stub.calls).toHaveLength(2);
    // 鍵が分かれていること（同一鍵だと 2 バッチ目が「同じ鍵の別宛先」で弾かれる）。
    expect(stub.calls[0].retryKey).toBe(base);
    expect(stub.calls[1].retryKey).toBe(await batchRetryKey(base, 1));
    expect(stub.calls[0].retryKey).not.toBe(stub.calls[1].retryKey);
    // 宛先もバッチごとに違う（鍵と宛先の対応が 1:1）。
    expect(stub.calls[0].to).toHaveLength(500);
    expect(stub.calls[1].to).toHaveLength(100);
  });
});

describe("承認判定は実オプション名の完全一致 allowlist（未知の新オプションを通さない・QA MID-5）", () => {
  it("allowlist にある値だけが承認。「承認」で始まる別オプションは通さない", () => {
    expect(isApprovedJudgment("承認")).toBe(true);
    expect(isApprovedJudgment(" 承認 ")).toBe(true);
    // 旧実装（startsWith）ではこれらが承認として通っていた。
    expect(isApprovedJudgment("承認前確認")).toBe(false);
    expect(isApprovedJudgment("承認済み")).toBe(false);
    expect(isApprovedJudgment("承認予定")).toBe(false);
    // allowlist に無い英語表記も通さない（実オプション名だけを通す）。
    expect(isApprovedJudgment("approved")).toBe(false);
    expect(isApprovedJudgment("未承認")).toBe(false);
    expect(isApprovedJudgment("")).toBe(false);
    expect(isApprovedJudgment(null)).toBe(false);
  });

  it("allowlist は差し替え可能。ただし否定語を含む値は設定ミスとして弾く", () => {
    // 実オプション名として明示的に allowlist に入れたものは通る（意図的な opt-in）。
    expect(isApprovedJudgment("承認済み", ["承認済み"])).toBe(true);
    // ただし既定 allowlist では通らない（差し替えは設定 1 か所の明示行為）。
    expect(isApprovedJudgment("承認済み")).toBe(false);
    expect(isApprovedJudgment("OK", ["OK", "承認"])).toBe(true);
    expect(isApprovedJudgment("承認", ["OK"])).toBe(false);
    // env に誤って否定系を入れても承認にはならない（fail-closed の保険）。
    expect(isApprovedJudgment("未承認", ["未承認"])).toBe(false);
    expect(isApprovedJudgment("却下", ["却下"])).toBe(false);
  });

  it("parseApprovalJudgments: 未設定・空は既定に倒す（緩めない）", () => {
    expect(parseApprovalJudgments(undefined)).toEqual([...DEFAULT_APPROVAL_JUDGMENTS]);
    expect(parseApprovalJudgments("")).toEqual([...DEFAULT_APPROVAL_JUDGMENTS]);
    expect(parseApprovalJudgments(" , ")).toEqual([...DEFAULT_APPROVAL_JUDGMENTS]);
    expect(parseApprovalJudgments("承認, 承認OK")).toEqual(["承認", "承認OK"]);
  });

  it("判定が allowlist 外なら送らない。allowlist を差し替えれば送れる", async () => {
    // 実オプション名が「承認 (送信可)」だった場合を模す。
    const blocked = await makeDeps({ judgment: "承認 (送信可)" });
    const res1 = await sendOneDelivery(blocked.deps, req);
    expect(res1.code).toBe("judgment_not_approved");
    expect(blocked.rec.sends).toHaveLength(0);

    const allowed = await makeDeps({ judgment: "承認 (送信可)" });
    allowed.deps.approvalJudgments = ["承認(送信可)"]; // 比較は NFKC + 空白除去後
    const res2 = await sendOneDelivery(allowed.deps, req);
    expect(res2.status).toBe("sent");
    expect(allowed.rec.sends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 一斉配信以外（宛先を列挙する multicast・「社内」等）でも request id を返す
//
// 背景（2026-09-24 00:47 JST 検証環境）: 「社内」向けは multicast で送られ、sender が
//   x-line-request-id を拾っていなかったため status=sent なのに requestId が空だった。
//   Mac 側の契約（sent かつ sentCount>0 かつ requestId あり）で「送信結果不明」になった。
// ---------------------------------------------------------------------------

const INTERNAL_TARGETS: ResolvedTargets = {
  kind: "multicast",
  userIds: ["Uaaa", "Ubbb", "Uccc"],
  batches: [["Uaaa", "Ubbb", "Uccc"]],
  estimatedRecipients: 3,
};

/** 「社内」（3 人・宛先列挙）を承認時人数 3 で送る要求。 */
const internalReq: SendOneRequest = {
  ...req,
  approvalRef: { ...req.approvalRef, approvedAudienceCount: 3 },
};

describe("一斉配信以外でも request id を返す（宛先列挙の送信・N-15）", () => {
  it("multicast の成功で sender が返した鍵を requestId / requestIds / 台帳へ載せる", async () => {
    const { deps, rec } = await makeDeps({
      targets: INTERNAL_TARGETS,
      audienceCount: 3,
      sendOutcomes: [
        {
          ok: true,
          deliveredRecipients: 3,
          partial: false,
          requestId: "mc-req-1",
          requestIds: ["mc-req-1"],
        },
      ],
    });
    const res = await sendOneDelivery(deps, internalReq);
    expect(res.status).toBe("sent");
    expect(res.code).toBe("sent");
    expect(res.sentCount).toBe(3);
    expect(res.requestId).toBe("mc-req-1");
    expect(res.requestIds).toEqual(["mc-req-1"]);
    expect(rec.sends.map((s) => s.kind)).toEqual(["multicast"]);
    expect(rec.results[0].status).toBe("Sent");
    expect(rec.finishInputs).toHaveLength(1);
    expect(rec.finishInputs[0]).toMatchObject({
      sendState: "sent",
      sentCount: 3,
      lineRequestId: "mc-req-1",
      lineRequestIds: ["mc-req-1"],
      // 宛先列挙の行は broadcast 専用の後追い補正に回さない。
      recipientsBasis: "addressed_list",
    });
  });

  it("multicast で送れたが鍵が 1 本も無ければ sent にしない（不明側・自動再送なし）", async () => {
    const { deps, rec } = await makeDeps({
      targets: INTERNAL_TARGETS,
      audienceCount: 3,
      sendOutcomes: [{ ok: true, deliveredRecipients: 3, partial: false }],
    });
    const res = await sendOneDelivery(deps, internalReq);
    expect(res.status).toBe("failed");
    expect(res.code).toBe("send_unconfirmed");
    expect(res.sentCount).toBe(0);
    expect(res.requestId).toBeNull();
    expect(res.requestIds).toEqual([]);
    expect(httpStatusFor(res)).toBe(502);
    expect(rec.results[0].status).toBe("Failed");
    expect(rec.sends).toHaveLength(1);
    expect(rec.finishInputs[0]).toMatchObject({ sendState: "failed", sentCount: 0 });
    expect(rec.finishInputs[0].lineRequestId).toBeUndefined();
  });

  it("鍵が空文字・空白だけなら取れていないのと同じ（broadcast でも sent にしない）", async () => {
    const { deps } = await makeDeps({
      sendOutcomes: [
        { ok: true, deliveredRecipients: 100, partial: false, requestId: "  ", requestIds: [""] },
      ],
    });
    const res = await sendOneDelivery(deps, req);
    expect(res.status).toBe("failed");
    expect(res.code).toBe("send_unconfirmed");
    expect(res.requestId).toBeNull();
  });

  it("broadcast の台帳には出所を書かない（後追い補正の対象のまま）", async () => {
    const { deps, rec } = await makeDeps();
    const res = await sendOneDelivery(deps, req);
    expect(res.requestId).toBe("req-1");
    expect(res.requestIds).toEqual(["req-1"]);
    expect(rec.finishInputs[0].lineRequestId).toBe("req-1");
    expect(rec.finishInputs[0].recipientsBasis).toBeUndefined();
  });

  it("collectRequestIds: 代表を先頭に、空白を除き重複なしで集める（純粋）", () => {
    expect(collectRequestIds({})).toEqual([]);
    expect(collectRequestIds({ requestId: "a" })).toEqual(["a"]);
    expect(collectRequestIds({ requestId: "a", requestIds: ["a", "b", " ", "b"] })).toEqual([
      "a",
      "b",
    ]);
    expect(collectRequestIds({ requestIds: ["", " x "] })).toEqual(["x"]);
  });

  it("requestIdFrom: x-line-request-id を trim して返し、無い・空白は null（純粋）", () => {
    expect(
      requestIdFrom(new Response(null, { headers: { [LINE_REQUEST_ID_HEADER]: " r-1 " } })),
    ).toBe("r-1");
    expect(requestIdFrom(new Response(null, { headers: { [LINE_REQUEST_ID_HEADER]: " " } }))).toBeNull();
    expect(requestIdFrom(new Response(null))).toBeNull();
  });
});

describe("実 sender（createLineSender）の multicast が鍵を拾う（fetch 差し替え・実送信ゼロ）", () => {
  it("「社内」相当（1 バッチ）: 200 の x-line-request-id が応答の requestId になる", async () => {
    const { deps, rec } = await makeDeps({ targets: INTERNAL_TARGETS, audienceCount: 3 });
    deps.sender = createLineSender(TEST_CHANNEL);
    const stub = stubFetch(
      () => new Response("{}", { status: 200, headers: { [LINE_REQUEST_ID_HEADER]: "line-mc-1" } }),
    );
    let res;
    try {
      res = await sendOneDelivery(deps, internalReq);
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url.endsWith("/multicast")).toBe(true);
    expect(stub.calls[0].to).toEqual(["Uaaa", "Ubbb", "Uccc"]);
    expect(res.status).toBe("sent");
    expect(res.sentCount).toBe(3);
    expect(res.requestId).toBe("line-mc-1");
    expect(res.requestIds).toEqual(["line-mc-1"]);
    expect(rec.finishInputs[0]).toMatchObject({
      sendState: "sent",
      lineRequestId: "line-mc-1",
      recipientsBasis: "addressed_list",
    });
  });

  it("2 バッチ: 両方の鍵を呼び出し順で requestIds に残し、requestId は先頭", async () => {
    const sender = createLineSender(TEST_CHANNEL);
    const userIds = Array.from({ length: 600 }, (_v, i) => `U${String(i).padStart(4, "0")}`);
    const stub = stubFetch(
      (_call, index) =>
        new Response("{}", {
          status: 200,
          headers: { [LINE_REQUEST_ID_HEADER]: `line-mc-batch-${index + 1}` },
        }),
    );
    let outcome: SendOutcome;
    try {
      outcome = await sender.multicast(
        chunkForMulticast(userIds),
        [{ type: "text", text: "テスト本文" }],
        undefined,
        await deterministicRetryKey(RESERVATION),
      );
    } finally {
      stub.restore();
    }
    expect(outcome.ok).toBe(true);
    expect(outcome.deliveredRecipients).toBe(600);
    expect(outcome.requestIds).toEqual(["line-mc-batch-1", "line-mc-batch-2"]);
    expect(outcome.requestId).toBe("line-mc-batch-1");
  });

  it("200 でも x-line-request-id が無ければ send_unconfirmed（Sent と記録しない）", async () => {
    const { deps, rec } = await makeDeps({ targets: INTERNAL_TARGETS, audienceCount: 3 });
    deps.sender = createLineSender(TEST_CHANNEL);
    const stub = stubFetch(() => new Response("{}", { status: 200 }));
    let res;
    try {
      res = await sendOneDelivery(deps, internalReq);
    } finally {
      stub.restore();
    }
    expect(res.status).toBe("failed");
    expect(res.code).toBe("send_unconfirmed");
    expect(res.requestId).toBeNull();
    expect(rec.results[0].status).toBe("Failed");
    // 送ってしまった可能性があるので再試行しない（1 回だけ叩いて止める）。
    expect(stub.calls).toHaveLength(1);
  });

  it("broadcast: 200 の鍵が空白だけなら取れていない扱い（旧実装は空文字を鍵ありと見ていた）", async () => {
    const sender = createLineSender(TEST_CHANNEL);
    const stub = stubFetch(
      () => new Response("{}", { status: 200, headers: { [LINE_REQUEST_ID_HEADER]: " " } }),
    );
    let outcome: SendOutcome;
    try {
      outcome = await sender.broadcast([{ type: "text", text: "x" }], 10);
    } finally {
      stub.restore();
    }
    expect(outcome.ok).toBe(true);
    expect(outcome.requestId).toBeUndefined();
    expect(outcome.requestIds).toEqual([]);
  });
});

describe("台帳への書き戻し（宛先列挙の鍵を補正ジョブに流さない）", () => {
  /** finish の update ペイロードだけを捕まえる最小の Supabase 偽物。 */
  function fakeSupabase() {
    const updates: Array<Record<string, unknown>> = [];
    const chain = {
      eq: () => chain,
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    };
    const client = {
      from: () => ({
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          return chain;
        },
      }),
    };
    return { updates, client: client as unknown as Parameters<typeof createSupabaseReservationPort>[0] };
  }

  it("multicast: line_request_id と recipients_basis=addressed_list、2 件以上は note に全件", async () => {
    const f = fakeSupabase();
    const port = createSupabaseReservationPort(f.client);
    await port.finish({
      pageId: PAGE_ID,
      month: "2026-09",
      sendState: "sent",
      sentCount: 600,
      lineRequestId: "k1",
      lineRequestIds: ["k1", "k2"],
      recipientsBasis: "addressed_list",
    });
    expect(f.updates).toEqual([
      {
        send_state: "sent",
        sent_count: 600,
        line_request_id: "k1",
        recipients_basis: "addressed_list",
        note: formatRequestIdsNote(["k1", "k2"]),
      },
    ]);
    expect(formatRequestIdsNote(["k1", "k2"])).toContain("k1,k2");
  });

  it("broadcast（鍵 1 本・出所なし）は従来どおり line_request_id だけ", async () => {
    const f = fakeSupabase();
    const port = createSupabaseReservationPort(f.client);
    await port.finish({
      pageId: PAGE_ID,
      month: "2026-09",
      sendState: "sent",
      sentCount: 100,
      lineRequestId: "b1",
      lineRequestIds: ["b1"],
    });
    expect(f.updates).toEqual([{ send_state: "sent", sent_count: 100, line_request_id: "b1" }]);
  });

  it("後追い補正は出所が未記録か、実数でも宛先列挙でもない行だけを拾う", () => {
    expect(RECONCILE_PENDING_FILTER).toBe(
      "recipients_basis.is.null,recipients_basis.not.in.(actual_delivered,addressed_list)",
    );
  });
});
