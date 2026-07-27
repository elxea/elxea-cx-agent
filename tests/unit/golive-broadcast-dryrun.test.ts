/**
 * Unit Tests -- 全員(broadcast) go-live 経路の dry-run 実証（実送信ゼロ）
 *
 * 目的:
 *   本番 go-live 対象行「【本番】上賀茂手作り市 全員配信」(page 3a870c9d-064c-8085-...) の
 *   全員(broadcast) 経路を、実 LINE / 実 Notion / 実 Supabase / 実 R2 に一切触れず
 *   純粋関数レベルで実証する。検証項目:
 *     - 配信対象「全員」→ kind=all（broadcast パス）
 *     - kind=all の target 解決 = LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD(=48)
 *     - 自己承認 pin 受理: prod 専用フラグで独立性免除・承認者ゼロは常に fail-closed
 *     - 画像 2 枚の恒久 R2 公開 URL を決定的に再構成（broadcast/<pageId>/<i>.jpg）
 *     - 送信ゲート: sendEnabled = DELIVERY_SEND_ENABLED === "true"。本番未設定 → false（dry-run）
 *
 *   ※ 実送信を発生させる runDeliveryOnce(sendEnabled=true) 経路はここでは一切呼ばない。
 *      dry-run(sendEnabled=false) の「非破壊・無送信」早期 return の実証は
 *      tests/unit/delivery-send.test.ts の
 *      「runDeliveryOnce: 送信が起きない条件（安全性）」を正とする。
 *
 * 使用方法:
 *   npx tsx tests/unit/golive-broadcast-dryrun.test.ts
 */

import { parseAudience } from "../../src/lib/delivery-audience";
import { resolveTargets, type TargetResolverDeps } from "../../src/lib/target-resolver";
import { selfApprovalRelaxed, isApprovalAuthorized } from "../../src/lib/delivery-approval";
import { r2UrlsForPage, r2KeyForImage } from "../../src/lib/image-ingest";
import { computeContentHash } from "../../src/lib/content-hash";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`[OK] ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`[FAIL] ${label}`);
  }
}

// go-live 対象行の確定値
const PAGE_ID = "3a870c9d-064c-8085-a98d-c8cbf61b2ce2";
const PROD_ESTIMATE = 48; // LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD
const SETAKA = "8e87c527-a90a-4a0c-bbdf-579af5a58124"; // 担当者=承認者（単独運用の自己承認）
const IMAGE_COUNT = 2;

// broadcast 経路では broadcastEstimate 以外の I/O を呼ばないことも同時に検証するため、
// 他 dep は「呼ばれたら throw」にしておく（呼ばれない=正常）。
function broadcastOnlyDeps(estimate: number | null): TargetResolverDeps {
  return {
    loadLinkages: async () => {
      throw new Error("broadcast 経路で loadLinkages が呼ばれた（誤配線）");
    },
    loadPersonaUsers: async () => {
      throw new Error("broadcast 経路で loadPersonaUsers が呼ばれた（誤配線）");
    },
    loadPersonaLineUsers: async () => {
      throw new Error("broadcast 経路で loadPersonaLineUsers が呼ばれた（誤配線）");
    },
    broadcastEstimate: async () => estimate,
    loadAllowlistUserIds: async () => {
      throw new Error("broadcast 経路で loadAllowlistUserIds が呼ばれた（誤配線）");
    },
  };
}

async function main(): Promise<void> {
  // 1. 配信対象「全員」→ kind=all
  const audience = parseAudience("全員");
  check("配信対象「全員」は kind=all（broadcast パス）", audience?.kind === "all");

  // 2. target 解決 = 48（PROD 見積）
  if (audience) {
    const r = await resolveTargets(audience, broadcastOnlyDeps(PROD_ESTIMATE));
    check("kind=all → resolveTargets は broadcast", r.kind === "broadcast");
    check(
      `broadcast の target(estimatedRecipients) = ${PROD_ESTIMATE}`,
      r.kind === "broadcast" && r.estimatedRecipients === PROD_ESTIMATE,
    );

    // 2b. 見積 未設定/不正は fail-closed（無料枠ガードに載せられない）
    const bad = await resolveTargets(audience, broadcastOnlyDeps(null));
    check("broadcast 見積 null は error（fail-closed）", bad.kind === "error");
  }

  // 3. 自己承認 pin 受理（prod 専用フラグでのみ独立性免除・可逆）
  const relaxedProd = selfApprovalRelaxed({
    DELIVERY_TARGET_ENV: "prod",
    DELIVERY_ALLOW_SELF_APPROVAL_PROD: "true",
  });
  check("prod + PROD フラグ true → 自己承認 緩和 true", relaxedProd === true);

  const notRelaxedProdDefault = selfApprovalRelaxed({ DELIVERY_TARGET_ENV: "prod" });
  check(
    "prod + フラグ未設定 → 緩和されない（既定 fail-closed・可逆）",
    notRelaxedProdDefault === false,
  );

  const testFlagOnProd = selfApprovalRelaxed({
    DELIVERY_TARGET_ENV: "prod",
    DELIVERY_ALLOW_SELF_APPROVAL_TEST: "true",
  });
  check("prod に TEST フラグは効かない（緩和されない）", testFlagOnProd === false);

  // 承認者=担当者（Setaka 単独）の自己承認: 緩和 true でのみ受理
  check(
    "自己承認（担当者=承認者）は緩和 true で受理される",
    isApprovalAuthorized([SETAKA], [SETAKA], relaxedProd) === true,
  );
  check(
    "自己承認は緩和 false（既定）では拒否される（独立性ロック維持）",
    isApprovalAuthorized([SETAKA], [SETAKA], false) === false,
  );
  check(
    "承認者ゼロは緩和 true でも常に fail-closed",
    isApprovalAuthorized([SETAKA], [], relaxedProd) === false,
  );

  // 4. 画像 2 枚の恒久 R2 公開 URL を決定的に再構成
  const base = "https://pub-elxea-broadcast.r2.dev";
  const urls = r2UrlsForPage(PAGE_ID, IMAGE_COUNT, base);
  check("画像 2 枚 → R2 公開 URL 2 件", urls.length === IMAGE_COUNT);
  check(
    "R2 キーは broadcast/<pageId>/0.jpg",
    urls[0] === `${base}/${r2KeyForImage(PAGE_ID, 0)}` &&
      r2KeyForImage(PAGE_ID, 0) === `broadcast/${PAGE_ID}/0.jpg`,
  );
  check(
    "R2 キーは broadcast/<pageId>/1.jpg",
    urls[1] === `${base}/broadcast/${PAGE_ID}/1.jpg`,
  );

  // pin 時と送信時で同じ枚数なら同じ URL 群 → コンテンツハッシュ一致（TOCTOU 防止）
  const hashPin = await computeContentHash({ format: "image", body: "", imageUrls: urls });
  const hashSend = await computeContentHash({
    format: "image",
    body: "",
    imageUrls: r2UrlsForPage(PAGE_ID, IMAGE_COUNT, base),
  });
  check("pin/送信で同一枚数なら content hash 一致（凍結）", hashPin === hashSend);

  // 5. 送信ゲート: sendEnabled は DELIVERY_SEND_ENABLED === "true" の純粋等価
  //    本番は当該 secret 未設定/非 "true" → false（dry-run・実送信ゼロ）
  const gate = (env: { DELIVERY_SEND_ENABLED?: string }) =>
    env.DELIVERY_SEND_ENABLED === "true";
  check("DELIVERY_SEND_ENABLED 未設定 → sendEnabled=false（dry-run）", gate({}) === false);
  check(
    "DELIVERY_SEND_ENABLED='false' → sendEnabled=false（dry-run）",
    gate({ DELIVERY_SEND_ENABLED: "false" }) === false,
  );
  check(
    "DELIVERY_SEND_ENABLED='true' のときのみ true（go-live 時のみ）",
    gate({ DELIVERY_SEND_ENABLED: "true" }) === true,
  );

  console.log(`\n=== go-live broadcast dry-run: ${pass} passed / ${fail} failed ===`);
  if (fail > 0) {
    console.log(`FAILURES:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
