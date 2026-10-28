/**
 * ハーメティック — 上限付きの全員配信（narrowcast・2026-10-29）が「上限を超えて送らない」こと
 *
 * ─ なぜ要るか ─
 *
 *   無料枠の残り（台帳 93 通）より友だち（約 116 人）が多い月に、区分で絞らず「友だち全員から
 *   LINE が無作為に選んだ人に、残りの範囲で」送る口を足した。お客さまに届く送り口を広げる変更
 *   なので、止まるべき条件と、上限なしの回の挙動が変わらないことをテストで固定する。
 *
 * ─ 何を機械に留めるか ─
 *
 *   1. 上限は「全員」にだけ付く。区分・社内に上限が付いたら送らない（区分を無作為に削らない）
 *   2. 上限の値は指紋に入る。承認した上限と違う値・上限なしで来たら送らない
 *   3. 送る数 = 承認した上限・送る時点の台帳の残り・友だち数のいちばん小さい数。
 *      台帳の残りが 0 なら送らない。LINE に渡す limit.max もこの数
 *   4. narrowcast の中身は messages と limit {max, upToRemainingQuota:true} だけ
 *      （recipient・filter・forbidPartialDelivery・customAggregationUnits を付けない）
 *   5. X-Line-Retry-Key は予約 ID から決まる。request id が取れない成功は Sent にしない (N-15)
 *   6. 上限なしの回は今のまま（broadcast・残りを超えたら 1 通も送らない）
 *
 * ⚠ 実ネットワーク不使用・実送信ゼロ。LINE 送信ポートも Notion もすべて fake を注入する。
 *   実 sender（createLineSender）を通す検証は globalThis.fetch をこのテストの中だけ差し替える。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import {
  sendOneDelivery,
  httpStatusFor,
  type SendOneDeps,
  type SendOneRequest,
} from "../../src/lib/delivery-send-one";
import {
  pinDeliveryContent,
  approveDelivery,
  type DeliveryApproveDeps,
} from "../../src/lib/delivery-approve";
import { computeContentHash } from "../../src/lib/content-hash";
import {
  applyRecipientCap,
  audienceFingerprintKey,
  audienceLabel,
  parseAudience,
  parseRecipientCap,
  type AudienceSpec,
} from "../../src/lib/delivery-audience";
import {
  buildNarrowcastBody,
  createLineSender,
  deterministicRetryKey,
  LINE_ACCEPTED_REQUEST_ID_HEADER,
  LINE_NARROWCAST_URL,
  LINE_REQUEST_ID_HEADER,
  noopSender,
  createRecordingSender,
  type LineMessage,
  type SendOutcome,
} from "../../src/lib/line-messages";
import { resolveTargets, type ResolvedTargets, type TargetResolverDeps } from "../../src/lib/target-resolver";
import { ALL_TASKS_DATABASE_ID } from "../../src/lib/delivery-approval-task";
import type { DeliveryChannel } from "../../src/lib/delivery-channel";
import type { DeliveryPage, DeliveryResult } from "../../src/lib/delivery-repository";

const OWNER = "owner@example.test";
const PAGE_ID = "page-cap-0001";
const TASK_ID = "task-cap-0001";
const RESERVATION = "rsv-cap-0001";
const BODY = "テスト本文（上限付き・実送信ゼロ）";
const FRIENDS = 116;
const CAP = 93;

function makePage(over: Partial<DeliveryPage> = {}): DeliveryPage {
  return {
    id: PAGE_ID,
    title: "上限付きテスト配信",
    status: "Approved",
    audienceRaw: "全員",
    format: "text",
    body: BODY,
    imageSourceUrls: [],
    imageCount: 0,
    scheduledStart: null,
    sent: false,
    contentHash: null,
    estimate: null,
    assignees: [],
    approvers: [],
    lastEditedTime: "2026-10-29T00:00:00.000Z",
    ...over,
  };
}

/** 配信対象（と上限）から、pin が書くのと同じ指紋を作る。 */
async function hashFor(audienceRaw: string, cap?: number, body = BODY): Promise<string> {
  const parsed = parseAudience(audienceRaw);
  if (!parsed) throw new Error("fixture: audience 不正");
  const capped = applyRecipientCap(parsed, cap);
  if (!capped.ok) throw new Error(`fixture: ${capped.reason}`);
  return computeContentHash({
    format: "text",
    body,
    imageUrls: [],
    audience: audienceFingerprintKey(capped.spec),
  });
}

interface Recorded {
  results: DeliveryResult[];
  errors: string[];
  sends: Array<{ kind: "broadcast" | "multicast" | "narrowcast"; max?: number; retryKey?: string }>;
  claims: Array<{ recipients: number }>;
  finishInputs: Array<Parameters<SendOneDeps["reservation"]["finish"]>[0]>;
}

interface Opts {
  page?: Partial<DeliveryPage>;
  /** 指紋に使う上限（pin の時の上限）。undefined は上限なしの指紋。 */
  pinnedCap?: number;
  pinnedAudience?: string;
  confirmed?: number;
  apiUsage?: number;
  targets?: ResolvedTargets;
  /** false にすると narrowcast を持たない sender にする。 */
  withNarrowcast?: boolean;
  outcome?: SendOutcome;
}

async function makeDeps(opts: Opts = {}): Promise<{ deps: SendOneDeps; rec: Recorded }> {
  const audienceRaw = opts.page?.audienceRaw ?? "全員";
  const page = makePage({
    contentHash: await hashFor(opts.pinnedAudience ?? audienceRaw, opts.pinnedCap),
    ...opts.page,
  });
  const rec: Recorded = { results: [], errors: [], sends: [], claims: [], finishInputs: [] };
  const outcome: SendOutcome =
    opts.outcome ?? { ok: true, deliveredRecipients: 0, partial: false, requestId: "req-cap-1" };
  const sender: SendOneDeps["sender"] = {
    broadcast: async (_m, n, _u, retryKey) => {
      rec.sends.push({ kind: "broadcast", max: n, retryKey });
      return { ...outcome, deliveredRecipients: outcome.deliveredRecipients || n };
    },
    multicast: async (b, _m, _u, retryKey) => {
      const n = b.reduce((s, x) => s + x.length, 0);
      rec.sends.push({ kind: "multicast", max: n, retryKey });
      return { ...outcome, deliveredRecipients: outcome.deliveredRecipients || n };
    },
  };
  if (opts.withNarrowcast !== false) {
    sender.narrowcast = async (_m, max, retryKey) => {
      rec.sends.push({ kind: "narrowcast", max, retryKey });
      return { ...outcome, deliveredRecipients: outcome.deliveredRecipients || max };
    };
  }
  const deps: SendOneDeps = {
    repo: {
      fetchPage: async () => page,
      setStatus: async () => {},
      writeResult: async (_id, r) => {
        rec.results.push(r);
      },
      writeError: async (_id, reason) => {
        rec.errors.push(reason);
      },
    },
    reservation: {
      claim: async (input) => {
        rec.claims.push({ recipients: input.recipients });
        return { kind: "claimed" };
      },
      finish: async (input) => {
        rec.finishInputs.push(input);
      },
    },
    confirmedConsumption: async () => opts.confirmed ?? 0,
    // 既定: 今月 97 通使った → 台帳の残り = 200 - 10 - 97 = 93
    consumption: async () => ({ ok: true, totalUsage: opts.apiUsage ?? 97 }),
    approvalTask: {
      fetchTask: async () => ({
        judgment: "承認",
        lastEditedById: "u-owner",
        lastEditedTime: "2026-10-29T00:00:00.000Z",
        parentDatabaseId: ALL_TASKS_DATABASE_ID,
        parentDataSourceId: null,
        details: `理由をここに\n要約\napproval_key=elxea-line-delivery:staging:${PAGE_ID} 対象: `,
        targetUrl: "",
      }),
      resolveUserEmail: async () => OWNER,
    },
    ownerEmail: OWNER,
    siteOpen: true,
    // 実 resolver を通す（上限 → narrowcast の変換もここで見る）。友だち数は FRIENDS。
    resolveTargets: async (audience: AudienceSpec) =>
      opts.targets ?? resolveTargets(audience, fakeTargetDeps(FRIENDS)),
    sender,
    now: () => new Date("2026-10-29T04:00:00.000Z"),
    imageUrlsFor: () => [],
    guardOptions: { cap: 200, safetyHeadroom: 10 },
  };
  return { deps, rec };
}

function fakeTargetDeps(friends: number | null): TargetResolverDeps {
  return {
    loadLinkages: async () => [],
    loadPersonaUsers: async () => [],
    loadPersonaLineUsers: async () => [],
    broadcastEstimate: async () => friends,
    loadAllowlistUserIds: async () => ["U-internal-fake-1"],
  };
}

function reqOf(over: Partial<SendOneRequest> = {}): SendOneRequest {
  return {
    pageId: PAGE_ID,
    approvalRef: {
      taskPageId: TASK_ID,
      approvedEditorEmail: OWNER,
      approvedEditedTime: "2026-10-29T00:00:00.000Z",
      approvedAudienceCount: CAP,
    },
    reservationId: RESERVATION,
    recipientCap: CAP,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. 上限の読み方・配信対象への載せ方・指紋
// ---------------------------------------------------------------------------

describe("上限の読み方（parseRecipientCap / applyRecipientCap）", () => {
  it("未指定は上限なし。1 以上の整数（数・数字だけの文字列）だけを受ける", () => {
    expect(parseRecipientCap(undefined)).toEqual({ ok: true, cap: undefined });
    expect(parseRecipientCap(null)).toEqual({ ok: true, cap: undefined });
    expect(parseRecipientCap(93)).toEqual({ ok: true, cap: 93 });
    expect(parseRecipientCap("93")).toEqual({ ok: true, cap: 93 });
    for (const bad of [0, -1, 1.5, Number.NaN, "", "abc", "9x", true, {}, []]) {
      expect(parseRecipientCap(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("上限は「全員」にだけ付く。区分・社内に付けたら拒否", () => {
    const all = parseAudience("全員")!;
    expect(applyRecipientCap(all, undefined)).toEqual({ ok: true, spec: all });
    expect(applyRecipientCap(all, 93)).toEqual({ ok: true, spec: { kind: "all", maxRecipients: 93 } });
    expect(applyRecipientCap(parseAudience("癒し")!, 93).ok).toBe(false);
    expect(applyRecipientCap(parseAudience("社内")!, 93).ok).toBe(false);
  });

  it("指紋: 上限なしの全員は従来どおり \"all\"。上限付きは値まで入る", () => {
    expect(audienceFingerprintKey({ kind: "all" })).toBe("all");
    expect(audienceFingerprintKey({ kind: "all", maxRecipients: 93 })).toBe("all:max=93");
    expect(audienceFingerprintKey({ kind: "all", maxRecipients: 94 })).not.toBe("all:max=93");
    expect(audienceLabel({ kind: "all" })).toBe("全員");
    expect(audienceLabel({ kind: "all", maxRecipients: 93 })).toContain("上限93");
  });
});

// ---------------------------------------------------------------------------
// 2. 対象の解決（上限 → narrowcast）
// ---------------------------------------------------------------------------

describe("対象の解決: 上限付きの全員は narrowcast", () => {
  it("上限 93 / 友だち 116 → narrowcast・max 93・友だち 116", async () => {
    const t = await resolveTargets({ kind: "all", maxRecipients: 93 }, fakeTargetDeps(116));
    expect(t).toEqual({ kind: "narrowcast", maxRecipients: 93, estimatedRecipients: 93, friendCount: 116 });
  });

  it("上限が友だち数より大きければ友だち数まで", async () => {
    const t = await resolveTargets({ kind: "all", maxRecipients: 500 }, fakeTargetDeps(116));
    expect(t.kind).toBe("narrowcast");
    if (t.kind === "narrowcast") expect(t.maxRecipients).toBe(116);
  });

  it("上限なしの全員は従来どおり broadcast（回帰）", async () => {
    const t = await resolveTargets({ kind: "all" }, fakeTargetDeps(116));
    expect(t).toEqual({ kind: "broadcast", estimatedRecipients: 116 });
  });

  it("友だち数が数えられなければ上限付きでも止まる（fail-closed）", async () => {
    const t = await resolveTargets({ kind: "all", maxRecipients: 93 }, fakeTargetDeps(null));
    expect(t.kind).toBe("error");
  });

  it("上限の値が壊れていたら送り口を作らない", async () => {
    const t = await resolveTargets({ kind: "all", maxRecipients: 0 }, fakeTargetDeps(116));
    expect(t.kind).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// 3. narrowcast の中身（実 sender を fetch 差し替えで通す・実送信ゼロ）
// ---------------------------------------------------------------------------

interface StubCall {
  url: string;
  retryKey?: string;
  body: Record<string, unknown>;
}

function stubFetch(
  handler: (call: StubCall, index: number) => Response | Promise<Response>,
): { calls: StubCall[]; restore: () => void } {
  const calls: StubCall[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call: StubCall = { url, retryKey: headers.get("X-Line-Retry-Key") ?? undefined, body };
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

const MSGS: LineMessage[] = [{ type: "text", text: "テスト" }];

describe("narrowcast の中身", () => {
  it("buildNarrowcastBody は messages と limit {max, upToRemainingQuota:true} だけ", () => {
    const b = buildNarrowcastBody(MSGS, 93);
    expect(Object.keys(b).sort()).toEqual(["limit", "messages"]);
    expect(b.limit).toEqual({ max: 93, upToRemainingQuota: true });
  });

  it("実 sender: 宛先指定なしで narrowcast の口に送り、再試行キーと request id を扱う", async () => {
    const stub = stubFetch(() =>
      new Response("{}", { status: 202, headers: { [LINE_REQUEST_ID_HEADER]: "nc-req-1" } }),
    );
    let out: SendOutcome;
    try {
      out = await createLineSender(TEST_CHANNEL).narrowcast!(MSGS, 93, "rk-1");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call.url).toBe(LINE_NARROWCAST_URL);
    expect(call.retryKey).toBe("rk-1");
    // 付けてはいけないもの: recipient（付けると絞り込み）・filter・forbidPartialDelivery（全体取り消し）・
    // customAggregationUnits（narrowcast の要求に無い）。
    expect(Object.keys(call.body).sort()).toEqual(["limit", "messages"]);
    expect(call.body.limit).toEqual({ max: 93, upToRemainingQuota: true });
    expect(out.ok).toBe(true);
    expect(out.deliveredRecipients).toBe(93);
    expect(out.requestId).toBe("nc-req-1");
  });

  it("409 + 受理済みの鍵は届いた扱い / 429 は失敗 / 例外は失敗", async () => {
    const accepted = stubFetch(() =>
      new Response("conflict", { status: 409, headers: { [LINE_ACCEPTED_REQUEST_ID_HEADER]: "acc-1" } }),
    );
    let a: SendOutcome;
    try {
      a = await createLineSender(TEST_CHANNEL).narrowcast!(MSGS, 10, "rk");
    } finally {
      accepted.restore();
    }
    expect(a.ok).toBe(true);
    expect(a.alreadyAccepted).toBe(true);
    expect(a.requestId).toBe("acc-1");

    const limited = stubFetch(() => new Response("You have reached your monthly limit.", { status: 429 }));
    let l: SendOutcome;
    try {
      l = await createLineSender(TEST_CHANNEL).narrowcast!(MSGS, 10, "rk");
    } finally {
      limited.restore();
    }
    expect(l.ok).toBe(false);
    expect(l.deliveredRecipients).toBe(0);

    const thrown = stubFetch(() => {
      throw new Error("network");
    });
    let t: SendOutcome;
    try {
      t = await createLineSender(TEST_CHANNEL).narrowcast!(MSGS, 10, "rk");
    } finally {
      thrown.restore();
    }
    expect(t.ok).toBe(false);
  });

  it("上限が 1 未満なら LINE を呼ばない", async () => {
    const stub = stubFetch(() => new Response("{}", { status: 202 }));
    let out: SendOutcome;
    try {
      out = await createLineSender(TEST_CHANNEL).narrowcast!(MSGS, 0, "rk");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
    expect(out.ok).toBe(false);
  });

  it("dry-run と記録用の sender も narrowcast を持つ（送らない）", async () => {
    const noop = await noopSender.narrowcast!(MSGS, 5);
    expect(noop.deliveredRecipients).toBe(5);
    const recSender = createRecordingSender({ requestId: "r" });
    await recSender.narrowcast!(MSGS, 7, "rk");
    expect(recSender.calls).toEqual([{ kind: "narrowcast", recipients: 7, retryKey: "rk" }]);
  });
});

// ---------------------------------------------------------------------------
// 4. 1 件指定送信（上限付き）
// ---------------------------------------------------------------------------

describe("1 件指定送信: 上限付きの全員配信", () => {
  it("上限 93・残り 93・友だち 116 → narrowcast で 93 人まで・台帳も 93 で押さえる", async () => {
    const { deps, rec } = await makeDeps({ pinnedCap: CAP });
    const res = await sendOneDelivery(deps, reqOf());
    expect(res.status).toBe("sent");
    expect(res.sentCount).toBe(93);
    expect(rec.sends).toHaveLength(1);
    expect(rec.sends[0].kind).toBe("narrowcast");
    expect(rec.sends[0].max).toBe(93);
    expect(rec.sends[0].retryKey).toBe(await deterministicRetryKey(RESERVATION));
    expect(rec.claims).toEqual([{ recipients: 93 }]);
    // 後追いの補正（insight/message/event）の対象から外さない = 出所の印を付けない。
    expect(rec.finishInputs[0].recipientsBasis).toBeUndefined();
    expect(rec.results[0].status).toBe("Sent");
    expect(rec.results[0].summary).toContain("無作為");
    expect(rec.results[0].summary).toContain("116");
  });

  it("送る時点で台帳の残りが減っていたら、残りの数まで減らして送る（増やす向きには動かない）", async () => {
    // 今月 110 通使用 → 残り 80
    const { deps, rec } = await makeDeps({ pinnedCap: CAP, apiUsage: 110 });
    const res = await sendOneDelivery(deps, reqOf());
    expect(res.status).toBe("sent");
    expect(rec.sends[0].max).toBe(80);
    expect(rec.claims).toEqual([{ recipients: 80 }]);
  });

  it("台帳の確定消費の方が多ければ、そちらの残りで減らす（厳しい方）", async () => {
    const { deps, rec } = await makeDeps({ pinnedCap: CAP, apiUsage: 97, confirmed: 150 });
    await sendOneDelivery(deps, reqOf());
    expect(rec.sends[0].max).toBe(40);
  });

  it("台帳の残りが 0 なら送らない", async () => {
    const { deps, rec } = await makeDeps({ pinnedCap: CAP, apiUsage: 190 });
    const res = await sendOneDelivery(deps, reqOf());
    expect(res.code).toBe("ledger_exhausted");
    expect(rec.sends).toHaveLength(0);
    expect(rec.claims).toHaveLength(0);
  });

  it("友だちが増えても送る数は上限のまま（+10% の門に当たらない）", async () => {
    const { deps, rec } = await makeDeps({
      pinnedCap: CAP,
      targets: { kind: "narrowcast", maxRecipients: 93, estimatedRecipients: 93, friendCount: 150 },
    });
    const res = await sendOneDelivery(deps, reqOf());
    expect(res.status).toBe("sent");
    expect(rec.sends[0].max).toBe(93);
  });

  it("承認した上限と違う値で来たら送らない（指紋が合わない）", async () => {
    const { deps, rec } = await makeDeps({ pinnedCap: CAP });
    const res = await sendOneDelivery(deps, reqOf({ recipientCap: 94 }));
    expect(res.code).toBe("fingerprint_mismatch");
    expect(rec.sends).toHaveLength(0);
  });

  it("上限付きで承認したのに上限なしで来たら送らない（黙って全員 broadcast にしない）", async () => {
    const { deps, rec } = await makeDeps({ pinnedCap: CAP });
    const res = await sendOneDelivery(deps, reqOf({ recipientCap: undefined }));
    expect(res.code).toBe("fingerprint_mismatch");
    expect(rec.sends).toHaveLength(0);
  });

  it("上限なしで承認した行に上限付きで来ても送らない", async () => {
    const { deps, rec } = await makeDeps({ pinnedCap: undefined });
    const res = await sendOneDelivery(deps, reqOf());
    expect(res.code).toBe("fingerprint_mismatch");
    expect(rec.sends).toHaveLength(0);
  });

  it("区分（癒し）・社内に上限が付いて来たら送らない", async () => {
    for (const audienceRaw of ["癒し", "社内"]) {
      const { deps, rec } = await makeDeps({ page: { audienceRaw }, pinnedAudience: audienceRaw });
      const res = await sendOneDelivery(deps, reqOf());
      expect(res.code, audienceRaw).toBe("recipient_cap_invalid");
      expect(rec.sends, audienceRaw).toHaveLength(0);
    }
  });

  it("上限の値が壊れていたら要求の形の誤りとして断る", async () => {
    for (const bad of [0, -3, 1.5, "abc"]) {
      const { deps, rec } = await makeDeps({ pinnedCap: CAP });
      const res = await sendOneDelivery(deps, reqOf({ recipientCap: bad as unknown as number }));
      expect(res.code, String(bad)).toBe("bad_request");
      expect(httpStatusFor(res)).toBe(400);
      expect(rec.sends).toHaveLength(0);
    }
  });

  it("narrowcast を持たない sender では送らない（broadcast に落とさない）", async () => {
    const { deps, rec } = await makeDeps({ pinnedCap: CAP, withNarrowcast: false });
    const res = await sendOneDelivery(deps, reqOf());
    expect(res.status).toBe("failed");
    expect(res.code).toBe("send_failed");
    expect(rec.sends).toHaveLength(0);
  });

  it("実 sender: 202 でも request id が無ければ Sent にしない (N-15)", async () => {
    const { deps, rec } = await makeDeps({ pinnedCap: CAP });
    deps.sender = createLineSender(TEST_CHANNEL);
    const stub = stubFetch(() => new Response("{}", { status: 202 }));
    let res;
    try {
      res = await sendOneDelivery(deps, reqOf());
    } finally {
      stub.restore();
    }
    expect(res.code).toBe("send_unconfirmed");
    expect(rec.results[0].status).toBe("Failed");
    // 結果不明で自動の再送はしない（1 回だけ呼ぶ）。
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe(LINE_NARROWCAST_URL);
  });

  it("実 sender: 例外の後の再試行は同じ再試行キー、409 受理済みなら Sent", async () => {
    const { deps } = await makeDeps({ pinnedCap: CAP });
    deps.sender = createLineSender(TEST_CHANNEL);
    const stub = stubFetch((_c, i) => {
      if (i === 0) throw new Error("timeout");
      return new Response("conflict", { status: 409, headers: { [LINE_ACCEPTED_REQUEST_ID_HEADER]: "acc-nc" } });
    });
    let res;
    try {
      res = await sendOneDelivery(deps, reqOf());
    } finally {
      stub.restore();
    }
    expect(res.status).toBe("sent");
    expect(res.requestId).toBe("acc-nc");
    const key = await deterministicRetryKey(RESERVATION);
    expect(stub.calls.map((c) => c.retryKey)).toEqual([key, key]);
  });
});

describe("1 件指定送信: 上限なしの回は今のまま（回帰）", () => {
  it("全員・上限なしは broadcast で、narrowcast を呼ばない", async () => {
    const { deps, rec } = await makeDeps({
      pinnedCap: undefined,
      apiUsage: 0,
    });
    const res = await sendOneDelivery(
      deps,
      reqOf({
        recipientCap: undefined,
        approvalRef: { ...reqOf().approvalRef, approvedAudienceCount: FRIENDS },
      }),
    );
    expect(res.status).toBe("sent");
    expect(rec.sends.map((s) => s.kind)).toEqual(["broadcast"]);
    expect(rec.claims).toEqual([{ recipients: FRIENDS }]);
  });

  it("全員・上限なしで友だちが残りより多ければ 1 通も送らない（全部か無しか）", async () => {
    const { deps, rec } = await makeDeps({ pinnedCap: undefined, apiUsage: 97 });
    const res = await sendOneDelivery(
      deps,
      reqOf({
        recipientCap: undefined,
        approvalRef: { ...reqOf().approvalRef, approvedAudienceCount: FRIENDS },
      }),
    );
    expect(res.code).toBe("ledger_exhausted");
    expect(rec.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. pin / approve（上限が指紋と人数に入る）
// ---------------------------------------------------------------------------

function approveDeps(row: DeliveryPage, friends = FRIENDS): { deps: DeliveryApproveDeps; pinned: string[] } {
  const pinned: string[] = [];
  const deps: DeliveryApproveDeps = {
    repo: {
      fetchPage: async () => row,
      pinContentSnapshot: async (_id, hash) => {
        pinned.push(hash);
        row.contentHash = hash;
      },
      markApproved: async () => {
        row.status = "Approved";
      },
      writeError: async () => {},
    },
    approvalTask: {
      fetchTask: async () => ({
        judgment: "承認",
        lastEditedById: "u-owner",
        lastEditedTime: "2026-10-29T00:30:00.000Z",
        parentDatabaseId: ALL_TASKS_DATABASE_ID,
        parentDataSourceId: null,
        details: `理由をここに\n要約\napproval_key=elxea-line-delivery:staging:${PAGE_ID} 対象: `,
        targetUrl: "",
      }),
      resolveUserEmail: async () => OWNER,
    },
    ownerEmail: OWNER,
    // 送信経路と同じ resolver で数える（上限付きは min(上限, 友だち数)）。
    resolveAudienceCount: async (audience) => {
      const t = await resolveTargets(audience, fakeTargetDeps(friends));
      return t.kind === "error" ? { ok: false, reason: t.reason } : { ok: true, count: t.estimatedRecipients };
    },
    ingestImages: async () => ({ ok: true, urls: [] }),
    imageUrlsFor: () => [],
  };
  return { deps, pinned };
}

const APPROVAL_REF = {
  taskPageId: TASK_ID,
  approvedEditorEmail: OWNER,
  approvedEditedTime: "2026-10-29T00:30:00.000Z",
};

describe("pin / approve: 上限付き", () => {
  it("pin は上限を指紋と人数に入れる（人数 = min(上限, 友だち数)）", async () => {
    const row = makePage({ status: "Draft" });
    const { deps, pinned } = approveDeps(row);
    const res = await pinDeliveryContent(deps, { pageId: PAGE_ID, recipientCap: CAP });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.audienceKey).toBe("all:max=93");
      expect(res.approvedAudienceCount).toBe(93);
      expect(res.contentHash).toBe(await hashFor("全員", CAP));
    }
    expect(pinned).toHaveLength(1);
  });

  it("pin: 上限なしは従来の指紋（\"all\"）と友だち数（回帰）", async () => {
    const row = makePage({ status: "Draft" });
    const { deps } = approveDeps(row);
    const res = await pinDeliveryContent(deps, { pageId: PAGE_ID });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.audienceKey).toBe("all");
      expect(res.approvedAudienceCount).toBe(FRIENDS);
      expect(res.contentHash).toBe(await hashFor("全員"));
    }
  });

  it("pin: 区分に上限は付けられない / 壊れた上限は形の誤り", async () => {
    const seg = approveDeps(makePage({ status: "Draft", audienceRaw: "癒し" }));
    const r1 = await pinDeliveryContent(seg.deps, { pageId: PAGE_ID, recipientCap: CAP });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("recipient_cap_invalid");
    expect(seg.pinned).toHaveLength(0);

    const bad = approveDeps(makePage({ status: "Draft" }));
    const r2 = await pinDeliveryContent(bad.deps, { pageId: PAGE_ID, recipientCap: 0 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("bad_request");
  });

  it("approve: pin と同じ上限なら承認、違う上限・上限なしなら承認しない", async () => {
    const row = makePage({ status: "Draft" });
    const { deps } = approveDeps(row);
    const pin = await pinDeliveryContent(deps, { pageId: PAGE_ID, recipientCap: CAP });
    expect(pin.ok).toBe(true);

    const other = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: APPROVAL_REF, recipientCap: 94 });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("content_changed_since_pin");

    const none = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: APPROVAL_REF });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.code).toBe("content_changed_since_pin");

    const same = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: APPROVAL_REF, recipientCap: CAP });
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.approvedAudienceCount).toBe(93);
      expect(same.audienceKey).toBe("all:max=93");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. 口（route）: 壊れた上限は黙って上限なしに倒さず 400（I/O の前に断る）
// ---------------------------------------------------------------------------

describe("口: 壊れた上限は 400", () => {
  const SECRET = "hermetic-mock-sync-api-secret-cap";
  type MutableEnv = { SYNC_API_SECRET?: string };
  beforeEach(() => {
    (env as unknown as MutableEnv).SYNC_API_SECRET = SECRET;
  });
  afterEach(() => {
    delete (env as unknown as MutableEnv).SYNC_API_SECRET;
  });

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://example.com${path}`, {
        ...init,
        headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("GET /api/delivery/ledger?recipientCap=abc → 400", async () => {
    const res = await call(`/api/delivery/ledger?pageId=${PAGE_ID}&recipientCap=abc`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("recipientCap");
  });

  it("POST /api/delivery/pin recipientCap=0 → 400", async () => {
    const res = await call("/api/delivery/pin", {
      method: "POST",
      body: JSON.stringify({ pageId: PAGE_ID, recipientCap: 0 }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("recipientCap");
  });
});
