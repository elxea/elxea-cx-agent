/**
 * Unit Tests -- 承認 1 点化の pin / approve（段1a-3・2026-09-22）
 *
 * 何を実証するか（すべて注入依存・ネットワーク非接触）:
 *   - pin は Status を動かさない（コンテンツハッシュだけを書く）
 *   - pin は **Draft（未承認）の行だけ** 受け付ける。Draft なら再 pin で上書き可（200）、
 *     承認後（Approved / Sending / Sent / Failed）は 409（pin_not_allowed_in_status）で
 *     拒否し Status も指紋も動かさない（承認済み内容と指紋の乖離を作らせない）
 *   - approve は **配信DB行の「承認者」people が空でも** All Tasks 判定行の検証で通る
 *     （承認 1 点化。旧 2 点承認の門を撤去した非回帰検査）
 *   - 判定行が未承認なら 422（judgment_not_approved）・Status を書かない
 *   - 判定行の最終編集者が owner 以外なら 422（editor_mismatch）
 *   - pin 後に本文が変わったら 422（content_changed_since_pin）・Status を書かない
 *   - pin を通っていない行は 422（pin_missing）
 *   - owner メール未設定は全拒否（owner_email_unset）
 *   - メール解決の一時失敗は 503（保留・再試行可。無効にしない）
 *
 * 使用方法:
 *   npx tsx tests/unit/delivery-approve.test.ts
 */

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function describe(suiteName: string, fn: () => void) {
  queue.push({ name: `--- ${suiteName} ---`, fn: () => {} });
  fn();
}
function it(testName: string, fn: () => void | Promise<void>) {
  queue.push({ name: testName, fn });
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertTrue(value: boolean, label = "") {
  if (!value) throw new Error(`${label ? label + ": " : ""}expected true`);
}

import {
  pinDeliveryContent,
  approveDelivery,
  httpStatusForApprove,
  type DeliveryApproveDeps,
  type DeliveryApproveResult,
} from "../../src/lib/delivery-approve";
import {
  ALL_TASKS_DATABASE_ID,
  ALL_TASKS_DATA_SOURCE_ID,
  ApprovalConfigError,
  RetryableApprovalError,
  checkApprovalTaskLink,
  type ApprovalTaskSnapshot,
} from "../../src/lib/delivery-approval-task";
import { isBearerAuthorized } from "../../src/lib/sync-auth";
import { computeContentHash } from "../../src/lib/content-hash";
import type { DeliveryPage } from "../../src/lib/delivery-repository";

const OWNER = "owner@example.test";
const PAGE_ID = "pg-1";
const TASK_ID = "task-1";

function page(overrides: Partial<DeliveryPage> = {}): DeliveryPage {
  return {
    id: PAGE_ID,
    title: "[検証] 承認 1 点化",
    status: "Draft",
    audienceRaw: "社内",
    format: "text",
    body: "本文テスト",
    imageSourceUrls: [],
    imageCount: 0,
    scheduledStart: null,
    sent: false,
    contentHash: null,
    estimate: null,
    // ⚠ 承認 1 点化の核心: これらは空のまま。承認の権威は All Tasks 判定行。
    assignees: [],
    approvers: [],
    lastEditedTime: "2026-09-22T10:00:00.000Z",
    ...overrides,
  };
}

/** text 行の指紋（pin が書く値と同じ組み立て）。 */
async function hashFor(p: DeliveryPage): Promise<string> {
  return computeContentHash({
    format: "text",
    body: p.body,
    imageUrls: [],
    audience: "allowlist",
  });
}

interface Recorder {
  pinned: string[];
  approved: string[];
  errors: string[];
}

function buildDeps(
  row: DeliveryPage,
  opts: {
    judgment?: string | null;
    editorId?: string | null;
    editorEmail?: string | null;
    emailThrows?: boolean;
    taskThrows?: boolean;
    taskError?: Error;
    task?: Partial<ApprovalTaskSnapshot>;
    ownerEmail?: string;
    audienceCount?: number;
    audienceError?: string;
  } = {},
): { deps: DeliveryApproveDeps; rec: Recorder } {
  const rec: Recorder = { pinned: [], approved: [], errors: [] };
  const deps: DeliveryApproveDeps = {
    repo: {
      fetchPage: async () => row,
      pinContentSnapshot: async (_id, hash) => {
        rec.pinned.push(hash);
        row.contentHash = hash;
      },
      markApproved: async (id) => {
        rec.approved.push(id);
        row.status = "Approved";
      },
      writeError: async (_id, reason) => {
        rec.errors.push(reason);
      },
    },
    approvalTask: {
      fetchTask: async () => {
        if (opts.taskThrows) throw new RetryableApprovalError("Notion 503");
        if (opts.taskError) throw opts.taskError;
        return {
          judgment: opts.judgment ?? "承認",
          lastEditedById: opts.editorId ?? "user-owner",
          lastEditedTime: "2026-09-22T10:30:00.000Z",
          parentDatabaseId: ALL_TASKS_DATABASE_ID,
          parentDataSourceId: null,
          details: `理由をここに\n要約\napproval_key=elxea-line-delivery:staging:${PAGE_ID} 対象: `,
          targetUrl: "",
          ...opts.task,
        };
      },
      resolveUserEmail: async () => {
        if (opts.emailThrows) throw new RetryableApprovalError("Notion 429");
        return opts.editorEmail === undefined ? OWNER : opts.editorEmail;
      },
    },
    ownerEmail: opts.ownerEmail === undefined ? OWNER : opts.ownerEmail,
    resolveAudienceCount: async () =>
      opts.audienceError
        ? { ok: false, reason: opts.audienceError }
        : { ok: true, count: opts.audienceCount ?? 4 },
    ingestImages: async () => ({ ok: true, urls: [] }),
    imageUrlsFor: () => [],
  };
  return { deps, rec };
}

function refOf(editorEmail = OWNER) {
  return {
    taskPageId: TASK_ID,
    approvedEditorEmail: editorEmail,
    approvedEditedTime: "2026-09-22T10:30:00.000Z",
  };
}

function codeOf(res: DeliveryApproveResult): string {
  return res.code;
}

// ---------------------------------------------------------------------------
// pin（prepare 段）
// ---------------------------------------------------------------------------
describe("pin: 指紋を固定するだけで Status を動かさない", () => {
  it("承認者 people が空でも pin できる（承認の権威は判定行）", async () => {
    const row = page();
    const { deps, rec } = buildDeps(row);
    const res = await pinDeliveryContent(deps, { pageId: PAGE_ID });
    assertTrue(res.ok, `pin ok (code=${codeOf(res)})`);
    assertEqual(codeOf(res), "pinned", "code");
    assertEqual(rec.pinned.length, 1, "ハッシュを 1 回書く");
    assertEqual(rec.approved.length, 0, "Status を書かない");
    assertEqual(row.status, "Draft", "Status は Draft のまま");
    assertEqual(httpStatusForApprove(res), 200, "HTTP 200");
  });
  it("応答に承認スナップショット（人数・audienceKey・hash）が載る", async () => {
    const row = page();
    const { deps } = buildDeps(row, { audienceCount: 4 });
    const res = await pinDeliveryContent(deps, { pageId: PAGE_ID });
    assertTrue(res.ok, "pin ok");
    if (!res.ok) return;
    assertEqual(res.approvedAudienceCount, 4, "人数");
    assertEqual(res.audienceKey, "allowlist", "社内 → allowlist");
    assertEqual(res.contentHash, await hashFor(row), "指紋は本文+対象で決まる");
  });
  it("配信対象の人数が 0 は pin しない（fail-closed・422）", async () => {
    const { deps, rec } = buildDeps(page(), { audienceCount: 0 });
    const res = await pinDeliveryContent(deps, { pageId: PAGE_ID });
    assertEqual(codeOf(res), "audience_empty", "code");
    assertEqual(rec.pinned.length, 0, "書かない");
    assertEqual(httpStatusForApprove(res), 422, "HTTP 422");
  });
  it("人数を解決できない一時失敗は保留（503・pin しない）", async () => {
    const { deps, rec } = buildDeps(page(), { audienceError: "LINE 5xx" });
    const res = await pinDeliveryContent(deps, { pageId: PAGE_ID });
    assertEqual(codeOf(res), "audience_unresolved", "code");
    assertEqual(rec.pinned.length, 0, "書かない");
    assertEqual(httpStatusForApprove(res), 503, "HTTP 503");
  });
  it("本文も画像も無い行は pin しない（422）", async () => {
    const { deps, rec } = buildDeps(page({ body: "  " }));
    const res = await pinDeliveryContent(deps, { pageId: PAGE_ID });
    assertEqual(codeOf(res), "message_invalid", "code");
    assertEqual(rec.pinned.length, 0, "書かない");
  });

  // 承認後の再 pin 封じ（QA 指摘・2026-09-23）。
  // 承認済みの行に再 pin を許すと「人が承認した内容」と「指紋」を別々にできてしまい、
  // approve の指紋照合も send-one の再照合も通ってしまう（未承認の内容が送信経路に乗る）。
  it("承認後（Approved / Sending / Sent / Failed）の行は再 pin を 409 で拒否・Status は変えない", async () => {
    for (const status of ["Approved", "Sending", "Sent", "Failed"]) {
      const approvedHash = "pinned-before-approval";
      const row = page({ status, body: "承認された本文", contentHash: approvedHash });
      const { deps, rec } = buildDeps(row);
      // 承認後に本文だけ差し替えて再 pin を試みる（指紋上書きの攻撃筋）。
      row.body = "承認後にこっそり差し替えた本文";
      const res = await pinDeliveryContent(deps, { pageId: PAGE_ID });
      assertEqual(codeOf(res), "pin_not_allowed_in_status", `code (status=${status})`);
      assertEqual(httpStatusForApprove(res), 409, `HTTP 409 (status=${status})`);
      assertEqual(rec.pinned.length, 0, `指紋を書かない (status=${status})`);
      assertEqual(row.contentHash, approvedHash, `承認時の指紋が残る (status=${status})`);
      assertEqual(rec.approved.length, 0, `Status を書かない (status=${status})`);
      assertEqual(row.status, status, `Status は ${status} のまま`);
    }
  });

  it("Draft（未承認）の行は再 pin を 200 で受け付け指紋を上書きする", async () => {
    const row = page({ body: "最初の本文" });
    const { deps, rec } = buildDeps(row);
    const first = await pinDeliveryContent(deps, { pageId: PAGE_ID });
    assertTrue(first.ok, `1 回目 pin ok (code=${codeOf(first)})`);
    assertEqual(httpStatusForApprove(first), 200, "1 回目 HTTP 200");
    const firstHash = row.contentHash;

    // まだ誰も承認していない（Draft）ので、本文を直しての再 pin は正当。
    row.body = "推敲した本文";
    const second = await pinDeliveryContent(deps, { pageId: PAGE_ID });
    assertTrue(second.ok, `2 回目 pin ok (code=${codeOf(second)})`);
    assertEqual(codeOf(second), "pinned", "code");
    assertEqual(httpStatusForApprove(second), 200, "2 回目 HTTP 200");
    assertEqual(rec.pinned.length, 2, "指紋を 2 回書く");
    assertEqual(row.contentHash, await hashFor(row), "新しい本文の指紋に更新される");
    assertTrue(row.contentHash !== firstHash, "指紋が上書きされている");
    assertEqual(rec.approved.length, 0, "Status を書かない");
    assertEqual(row.status, "Draft", "Status は Draft のまま");
  });
});

// ---------------------------------------------------------------------------
// approve（reserve 段）
// ---------------------------------------------------------------------------
describe("approve: 承認者 people 無しでも判定行の検証で通る（承認 1 点化）", () => {
  it("判定=承認 + 最終編集者=owner なら Status=Approved を機械が書く", async () => {
    const row = page();
    row.contentHash = await hashFor(row);
    const { deps, rec } = buildDeps(row, { audienceCount: 4 });
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertTrue(res.ok, `approve ok (code=${codeOf(res)})`);
    if (!res.ok) return;
    assertEqual(res.code, "approved", "code");
    assertEqual(rec.approved.length, 1, "Status=Approved を 1 回だけ書く");
    assertEqual(row.status, "Approved", "行は Approved");
    assertEqual(res.approvedAudienceCount, 4, "人数スナップショット");
    assertEqual(res.audienceKey, "allowlist", "audienceKey");
    assertEqual(res.contentHash, row.contentHash, "pin の指紋をそのまま返す");
    assertEqual(httpStatusForApprove(res), 200, "HTTP 200");
  });

  it("判定が未承認なら 422・Status を書かない", async () => {
    const row = page();
    row.contentHash = await hashFor(row);
    const { deps, rec } = buildDeps(row, { judgment: "未承認" });
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertEqual(codeOf(res), "judgment_not_approved", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
    assertEqual(row.status, "Draft", "Draft のまま");
    assertTrue(rec.errors.length > 0, "理由を行に残す");
    assertEqual(httpStatusForApprove(res), 422, "HTTP 422");
  });

  it("判定行の最終編集者が owner 以外なら 422（editor_mismatch）", async () => {
    const row = page();
    row.contentHash = await hashFor(row);
    const { deps, rec } = buildDeps(row, { editorEmail: "someone-else@example.test" });
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertEqual(codeOf(res), "editor_mismatch", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
  });

  it("pin 後に本文が変わったら 422（content_changed_since_pin）・Status を書かない", async () => {
    const row = page();
    row.contentHash = await hashFor(row);
    row.body = "承認 pin の後にこっそり書き換えた本文";
    const { deps, rec } = buildDeps(row);
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertEqual(codeOf(res), "content_changed_since_pin", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
    assertEqual(row.status, "Draft", "Draft のまま");
    assertEqual(httpStatusForApprove(res), 422, "HTTP 422");
  });

  it("pin 後に配信対象が変わったら 422（指紋に対象が入っている）", async () => {
    const row = page();
    row.contentHash = await hashFor(row); // 社内 = allowlist で pin
    row.audienceRaw = "全員";
    const { deps, rec } = buildDeps(row);
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertEqual(codeOf(res), "content_changed_since_pin", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
  });

  it("pin を通っていない行（ハッシュ空）は 422（pin_missing）", async () => {
    const row = page({ contentHash: "" });
    const { deps, rec } = buildDeps(row);
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertEqual(codeOf(res), "pin_missing", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
  });

  it("owner メール未設定は全拒否（owner_email_unset・422）", async () => {
    const row = page();
    row.contentHash = await hashFor(row);
    const { deps, rec } = buildDeps(row, { ownerEmail: "" });
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertEqual(codeOf(res), "owner_email_unset", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
    assertEqual(httpStatusForApprove(res), 422, "HTTP 422");
  });

  it("メール解決の一時失敗は 503（保留・再試行可。無効にしない）", async () => {
    const row = page();
    row.contentHash = await hashFor(row);
    const { deps, rec } = buildDeps(row, { emailThrows: true });
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertEqual(codeOf(res), "email_lookup_retryable", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
    assertEqual(rec.errors.length, 0, "一時失敗は行に赤字を残さない");
    assertEqual(httpStatusForApprove(res), 503, "HTTP 503");
  });

  it("判定行の取得が一時失敗なら 503（保留）", async () => {
    const row = page();
    row.contentHash = await hashFor(row);
    const { deps } = buildDeps(row, { taskThrows: true });
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertEqual(codeOf(res), "task_fetch_retryable", "code");
    assertEqual(httpStatusForApprove(res), 503, "HTTP 503");
  });

  it("承認スナップショットの編集者が owner 以外なら 422（Mac 側の固定値が無効）", async () => {
    const row = page();
    row.contentHash = await hashFor(row);
    const { deps, rec } = buildDeps(row);
    const res = await approveDelivery(deps, {
      pageId: PAGE_ID,
      approvalRef: refOf("intruder@example.test"),
    });
    assertEqual(codeOf(res), "editor_mismatch", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
  });

  it("approvalRef 欠落は 400（承認の権威が指定されていない）", async () => {
    const row = page();
    row.contentHash = await hashFor(row);
    const { deps } = buildDeps(row);
    const res = await approveDelivery(deps, { pageId: PAGE_ID } as never);
    assertEqual(codeOf(res), "bad_request", "code");
    assertEqual(httpStatusForApprove(res), 400, "HTTP 400");
  });

  it("送信済みの行は承認しない（409）", async () => {
    const row = page({ sent: true });
    row.contentHash = await hashFor(row);
    const { deps, rec } = buildDeps(row);
    const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
    assertEqual(codeOf(res), "row_already_sent", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
    assertEqual(httpStatusForApprove(res), 409, "HTTP 409");
  });
});

// ---------------------------------------------------------------------------
// pin → 人の承認 → approve の通し（順序そのものが安全性）
// ---------------------------------------------------------------------------
describe("prepare(pin) → 承認 → reserve(approve) の順序", () => {
  it("pin では Draft のまま / approve で初めて Approved になる", async () => {
    const row = page();
    const { deps, rec } = buildDeps(row, { audienceCount: 4 });
    const pin = await pinDeliveryContent(deps, { pageId: PAGE_ID });
    assertTrue(pin.ok, "pin ok");
    assertEqual(row.status, "Draft", "pin 後も Draft");
    const approve = await approveDelivery(deps, {
      pageId: PAGE_ID,
      approvalRef: refOf(),
    });
    assertTrue(approve.ok, `approve ok (code=${codeOf(approve)})`);
    assertEqual(row.status, "Approved", "approve で Approved");
    assertEqual(rec.approved.length, 1, "Status 書き込みは 1 回");
  });
});


// ---------------------------------------------------------------------------
// 案B: 承認確認は専用接続・親DB照合・配信行との紐付け照合（2026-09-23）
// ---------------------------------------------------------------------------
async function approveWith(opts: Parameters<typeof buildDeps>[1]) {
  const row = page();
  const { deps, rec } = buildDeps(row, opts);
  const pin = await pinDeliveryContent(deps, { pageId: PAGE_ID });
  assertTrue(pin.ok, "pin ok");
  const res = await approveDelivery(deps, { pageId: PAGE_ID, approvalRef: refOf() });
  return { res, rec, row };
}

describe("approve: 承認確認の設定エラーは再試行しない（503 にしない）", () => {
  it("NOTION_APPROVAL_TOKEN 未設定 → 422 approval_token_unset・Status を書かない", async () => {
    const { res, rec, row } = await approveWith({
      taskError: new ApprovalConfigError("approval_token_unset", "未設定"),
    });
    assertEqual(codeOf(res), "approval_token_unset", "code");
    assertEqual(httpStatusForApprove(res), 422, "http");
    assertTrue(!res.ok && res.retryable === false, "retryable=false");
    assertEqual(rec.approved.length, 0, "Status を書かない");
    assertEqual(row.status, "Draft", "Draft のまま");
  });
  it("判定行の 404（接続への共有漏れ）→ 422 task_not_shared（row_fetch_failed/503 に化けない）", async () => {
    const { res, rec } = await approveWith({
      taskError: new ApprovalConfigError("task_not_shared", "Notion 404"),
    });
    assertEqual(codeOf(res), "task_not_shared", "code");
    assertEqual(httpStatusForApprove(res), 422, "http");
    assertEqual(rec.approved.length, 0, "Status を書かない");
  });
  it("token 無効（401/403 相当）→ 422 approval_token_invalid", async () => {
    const { res } = await approveWith({
      taskError: new ApprovalConfigError("approval_token_invalid", "Notion 401"),
    });
    assertEqual(codeOf(res), "approval_token_invalid", "code");
    assertEqual(httpStatusForApprove(res), 422, "http");
  });
  it("一時障害（503）は従来どおり 503・再試行可", async () => {
    const { res } = await approveWith({ taskThrows: true });
    assertEqual(codeOf(res), "task_fetch_retryable", "code");
    assertEqual(httpStatusForApprove(res), 503, "http");
  });
});

describe("approve: 判定行の親が All Tasks でなければ承認しない", () => {
  it("親 database が別 DB → 422 task_parent_mismatch・判定の値を応答に出さない", async () => {
    const { res, rec } = await approveWith({
      judgment: "承認",
      task: { parentDatabaseId: "11111111-2222-3333-4444-555555555555" },
    });
    assertEqual(codeOf(res), "task_parent_mismatch", "code");
    assertTrue(!res.ok && !res.reason.includes("現在値"), "判定の値を漏らさない");
    assertEqual(rec.approved.length, 0, "Status を書かない");
  });
  it("親が無い（ページ直下等）→ 拒否", async () => {
    const { res } = await approveWith({ task: { parentDatabaseId: null } });
    assertEqual(codeOf(res), "task_parent_mismatch", "code");
  });
  it("新しい API 版の parent.data_source_id（ハイフン無し）でも All Tasks なら通る", async () => {
    const { res } = await approveWith({
      task: {
        parentDatabaseId: null,
        parentDataSourceId: ALL_TASKS_DATA_SOURCE_ID.replace(/-/g, ""),
      },
    });
    assertTrue(res.ok, `approve ok (code=${codeOf(res)})`);
  });
});

describe("approve: 判定行が別の配信行の承認なら承認しない（使い回し防止）", () => {
  it("approval_key が別の配信行 → 422 task_link_mismatch", async () => {
    const { res, rec } = await approveWith({
      task: { details: "approval_key=elxea-line-delivery:staging:pg-2 対象: " },
    });
    assertEqual(codeOf(res), "task_link_mismatch", "code");
    assertEqual(rec.approved.length, 0, "Status を書かない");
  });
  it("approval_key が無い → 拒否", async () => {
    const { res } = await approveWith({ task: { details: "理由をここに\n要約だけ" } });
    assertEqual(codeOf(res), "task_link_mismatch", "code");
  });
  it("LINE 配信以外の approval_key → 拒否", async () => {
    const { res } = await approveWith({
      task: { details: `approval_key=outbound-warm:staging:${PAGE_ID} 対象: ` },
    });
    assertEqual(codeOf(res), "task_link_mismatch", "code");
  });
  it("正しい鍵に加えて別行を指す鍵が書き足されていたら拒否", async () => {
    const { res } = await approveWith({
      task: {
        details:
          `approval_key=elxea-line-delivery:staging:pg-2\n` +
          `approval_key=elxea-line-delivery:staging:${PAGE_ID} 対象: `,
      },
    });
    assertEqual(codeOf(res), "task_link_mismatch", "code");
  });
});

describe("checkApprovalTaskLink: 実形式（uuid・URL 列）", () => {
  const PID = "3e470c9d-064c-8112-aaaa-0123456789ab";
  const base: ApprovalTaskSnapshot = {
    judgment: "承認",
    lastEditedById: "u",
    lastEditedTime: null,
    parentDatabaseId: ALL_TASKS_DATABASE_ID,
    parentDataSourceId: null,
    details: `理由をここに\n要約\napproval_key=elxea-line-delivery:production:${PID} 対象: https://www.notion.so/${PID.replace(/-/g, "")}`,
    targetUrl: `https://www.notion.so/LINE-${PID.replace(/-/g, "")}`,
  };
  it("鍵と URL 列が配信行を指せば ok（ハイフン有無を問わない）", () => {
    assertTrue(checkApprovalTaskLink(base, PID).ok, "with dashes");
    assertTrue(checkApprovalTaskLink(base, PID.replace(/-/g, "").toUpperCase()).ok, "no dashes");
  });
  it("URL 列だけ別の行を指していたら拒否", () => {
    const t = { ...base, targetUrl: "https://www.notion.so/ffffffffffffffffffffffffffffffff" };
    assertTrue(!checkApprovalTaskLink(t, PID).ok, "url mismatch");
  });
  it("URL 列が空なら approval_key だけで判定", () => {
    assertTrue(checkApprovalTaskLink({ ...base, targetUrl: "" }, PID).ok, "empty url");
  });
  it("照合先の配信行 id が空なら拒否", () => {
    assertTrue(!checkApprovalTaskLink(base, "").ok, "empty expected");
  });
});

describe("SYNC_API_SECRET の Bearer 照合（定数時間比較・意味は旧実装と同じ）", () => {
  it("完全一致だけ通す", () => {
    assertTrue(isBearerAuthorized("Bearer s3cret", "s3cret"), "match");
    assertTrue(!isBearerAuthorized("Bearer s3cre", "s3cret"), "prefix");
    assertTrue(!isBearerAuthorized("Bearer s3cret ", "s3cret"), "trailing space");
    assertTrue(!isBearerAuthorized("bearer s3cret", "s3cret"), "case");
    assertTrue(!isBearerAuthorized(undefined, "s3cret"), "no header");
  });
  it("secret 未設定・空は常に拒否", () => {
    assertTrue(!isBearerAuthorized("Bearer ", ""), "empty secret");
    assertTrue(!isBearerAuthorized("Bearer undefined", undefined), "undefined secret");
  });
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
(async () => {
  console.log("=== delivery-approve（承認 1 点化 pin / approve）===\n");
  for (const t of queue) {
    if (t.name.startsWith("---")) {
      console.log(`\n${t.name}`);
      continue;
    }
    try {
      await t.fn();
      passed++;
      console.log(`[OK] ${t.name}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ name: t.name, error: msg });
      console.log(`[FAIL] ${t.name}: ${msg}`);
    }
  }
  console.log(`\n=== ${passed} passed / ${failed} failed ===`);
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
