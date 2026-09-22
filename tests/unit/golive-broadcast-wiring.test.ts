/**
 * Unit Tests -- 全員(broadcast) 経路の配線実証（実送信ゼロ）
 *
 * 目的:
 *   全員(broadcast) 配信経路を、実 LINE / 実 Notion / 実 Supabase / 実 R2 に一切触れず
 *   純粋関数レベルで実証する。検証項目:
 *     - 配信対象「全員」→ kind=all（broadcast パス）
 *     - kind=all の target 解決 = 注入された見積がそのまま載ること + 見積 null は fail-closed
 *       ⚠ 2026-09-11: 見積の正は「送信のたびの実測」に変わった（line-audience-size.ts）。
 *         env の LINE_BROADCAST_ESTIMATED_RECIPIENTS_* は**フォールバック専用**へ降格。
 *         本テストは resolveTargets に見積を直接注入するので、その転換の影響を受けない
 *         （= fail-closed の非回帰検査としてそのまま生きる）。実測経路の検証は
 *         tests/unit/broadcast-recipients.test.ts。
 *     - 承認 pin は指紋の固定だけを行い Status を動かさない（承認 1 点化・2026-09-22）。
 *       配信DB行の people 列「承認者」「担当者」は判定に使わないため、旧「自己承認 pin 受理」
 *       検査（selfApprovalRelaxed / isApprovalAuthorized）は削除した。承認の検証は
 *       All Tasks 判定行（delivery-approval-task.ts）が持ち、実証は delivery-approve.test.ts。
 *     - 画像 2 枚の恒久 R2 公開 URL を決定的に再構成（broadcast/<pageId>/<i>.jpg）
 *     - 実送信スイッチ非復活ガード: 送信経路のソースに env 送信フラグが再導入されていない
 *
 *   ※ 本ファイルは実送信を発生させる経路を一切呼ばない（純粋関数のみ）。
 *      送信そのものの分岐実証は tests/unit/delivery-send.test.ts を正とする。
 *
 * 2026-08-22: 実送信スイッチ（DELIVERY_SEND_ENABLED）撤去に伴い、旧
 *   golive-broadcast-dryrun.test.ts から改称。dry-run モードは存在しない。
 *
 * 使用方法:
 *   npx tsx tests/unit/golive-broadcast-wiring.test.ts
 */

import { readFileSync } from "node:fs";
import { parseAudience } from "../../src/lib/delivery-audience";
import { resolveTargets, type TargetResolverDeps } from "../../src/lib/target-resolver";
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
// 任意の見積値（注入専用）。かつては env 固定値 48 と同値である前提だったが、
// 2026-09-11 に見積の正が実測へ移ったため、ここは「注入した値がそのまま載るか」を見るだけの数。
const PROD_ESTIMATE = 48;
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

  // 3. 承認の権威は All Tasks 判定行（承認 1 点化・2026-09-22）。
  //    配信DB行の people 列を読む旧ゲート（delivery-approval.ts）は撤去済み = 非回帰ラチェット。
  const runtimeSrc = readFileSync("src/lib/delivery-runtime.ts", "utf8");
  check(
    "pin / approve 経路は delivery-approval.ts（承認者 people ゲート）を import しない",
    !runtimeSrc.includes("delivery-approval\"") &&
      !runtimeSrc.includes("isApprovalAuthorized"),
  );
  check(
    "承認 pin は Status を書かない（pinContentSnapshot を使う）",
    runtimeSrc.includes("pinContentSnapshot") && !runtimeSrc.includes("pinApproval("),
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
  const hashPin = await computeContentHash({ format: "image", body: "", imageUrls: urls, audience: "all" });
  const hashSend = await computeContentHash({
    format: "image",
    body: "",
    imageUrls: r2UrlsForPage(PAGE_ID, IMAGE_COUNT, base),
    audience: "all",
  });
  check("pin/送信で同一枚数なら content hash 一致（凍結）", hashPin === hashSend);

  // 5. 実送信スイッチ非復活ガード（2026-08-22 の撤去を機械で固定する）
  //    「承認したら送られる」を壊す env フラグが送信経路に再導入されていないことを、
  //    ソースの実コード行（コメント行を除く）に対して検査する。
  //    ⚠ ここでコメント行を除くのは、撤去の経緯コメントに旧フラグ名が残るため。
  const sendPathSources = [
    "src/lib/delivery-runtime.ts",
    "src/lib/delivery-send-one.ts",
    "src/index.ts",
  ];
  const codeLinesOf = (relPath: string): string[] =>
    readFileSync(new URL(`../../${relPath}`, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      });
  for (const rel of sendPathSources) {
    check(
      `${rel}: 実コードに DELIVERY_SEND_ENABLED を参照していない`,
      !codeLinesOf(rel).some((l) => l.includes("DELIVERY_SEND_ENABLED")),
    );
  }
  // 一斉配信の送信経路そのものには sendEnabled ゲートを一切持たない
  // （休眠 DORMANT / マルシェ MARCHE は別機能の別ゲートなので index.ts は対象外）。
  for (const rel of ["src/lib/delivery-runtime.ts", "src/lib/delivery-send-one.ts"]) {
    check(
      `${rel}: 実コードに sendEnabled ゲートが存在しない`,
      !codeLinesOf(rel).some((l) => /\bsendEnabled\b/.test(l)),
    );
  }

  console.log(`\n=== go-live broadcast wiring: ${pass} passed / ${fail} failed ===`);
  if (fail > 0) {
    console.log(`FAILURES:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
