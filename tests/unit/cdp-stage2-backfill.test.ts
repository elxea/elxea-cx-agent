/**
 * Unit — 写し取り（backfill）の判断だけを DB 抜きで固定する（migration 047）
 *
 * ここで固定するのは「DB にも HTTP にも触れない部分」だけ:
 *   - 接続先 ref の HARD ASSERT（staging のつもりで prod を書かない）
 *   - CLI の既定（**何も付けなければ staging / dry-run**）
 *   - 正規経路の関数に渡す引数（basis / observedBy / 鍵の種類）
 *   - 失敗の読み替え（写せなかった理由が「無言」にならない）
 *   - Messaging userId でない値で delivery_identity を作りにいかない
 *
 * 実配線（トリガ・連結成分・parity）は tests/db/cdp-stage2-backfill.db.test.ts が
 * 実 DB（staging・tx ROLLBACK）で見る。ここは「実 DB を用意しなくても壊れたら分かる」層。
 */

import {
  PROD_REF,
  STAGING_REF,
  BACKFILL_BASIS,
  BACKFILL_OBSERVED_BY,
  parseCli,
  assertTargetRef,
  classifyLink,
  backfillRow,
  summarize,
  mask,
  type BackfillDeps,
  type RowResult,
} from "../../scripts/cdp-stage2-backfill";
import type { SupabaseClient } from "@supabase/supabase-js";

let total = 0;
let passed = 0;
const failures: string[] = [];

async function it(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assertTrue(v: boolean, label: string) {
  if (!v) throw new Error(label);
}
function assertEqual<T>(a: T, b: T, label: string) {
  if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertDeep(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function assertThrows(fn: () => unknown, label: string) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${label}: 例外が投げられなかった`);
}

/** 実在しない Supabase クライアント。deps を全部差し替えるので触られない。 */
const FAKE_SUPABASE = {} as unknown as SupabaseClient;

const LINE_OK = "U0123456789abcdef0123456789abcdef";
const SHOPIFY = "7511000000254";

function deps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    appendLink: (async () => ({
      ok: true,
      appended: true,
      subjectA: "A".repeat(26),
      subjectB: "B".repeat(26),
      leftSubjectId: "L".repeat(26),
      rightSubjectId: "R".repeat(26),
    })) as unknown as BackfillDeps["appendLink"],
    upsertDelivery: (async () => ({ ok: true, updated: true })) as BackfillDeps["upsertDelivery"],
    resolveSubject: (async () => ({
      subjectId: "S".repeat(26),
      issued: false,
    })) as unknown as BackfillDeps["resolveSubject"],
    ...over,
  };
}

console.log("\n=== 接続先の取り違えを型ではなく実測で止める ===");

await it("staging のつもりで prod の URL を渡したら中断する", () => {
  assertThrows(
    () => assertTargetRef("staging", `https://${PROD_REF}.supabase.co`),
    "prod ref を staging として受け入れてしまった",
  );
});

await it("prod のつもりで staging の URL を渡しても中断する（両方向）", () => {
  assertThrows(
    () => assertTargetRef("prod", `https://${STAGING_REF}.supabase.co`),
    "staging ref を prod として受け入れてしまった",
  );
});

await it("一致するときだけ ref を返す", () => {
  assertEqual(assertTargetRef("staging", `https://${STAGING_REF}.supabase.co`), STAGING_REF, "staging");
  assertEqual(assertTargetRef("prod", `https://${PROD_REF}.supabase.co`), PROD_REF, "prod");
});

console.log("\n=== 既定は staging / dry-run（書くには明示が要る）===");

await it("引数無しは staging・dry-run", () => {
  assertDeep(parseCli([]), { env: "staging", apply: false }, "既定が安全側でない");
});

await it("--apply だけでは prod にならない", () => {
  assertDeep(parseCli(["--apply"]), { env: "staging", apply: true }, "既定 env が prod に倒れている");
});

await it("--env prod は明示したときだけ", () => {
  assertDeep(parseCli(["--env", "prod", "--apply"]), { env: "prod", apply: true }, "--env prod");
  assertDeep(parseCli(["--env=prod"]), { env: "prod", apply: false }, "--env=prod");
});

await it("--env に prod|staging 以外を渡したら中断する", () => {
  assertThrows(() => parseCli(["--env", "dev"]), "未知の env を受け入れてしまった");
});

console.log("\n=== 正規経路に渡す引数（根拠と経路名）===");

await it("basis は 047 が足した写し取り専用の値、observedBy は slug 規約を満たす", () => {
  assertEqual(BACKFILL_BASIS, "legacy_ledger_backfill", "basis が違う");
  assertTrue(
    /^[a-z0-9_.\-]{1,64}$/.test(BACKFILL_OBSERVED_BY),
    "observed_by が DB の slug CHECK を満たさない",
  );
});

await it("LINE 側は line_messaging_uid、Shopify 側は shopify_customer_id で渡す", async () => {
  let seen: { leftKind?: string; rightKind?: string; basis?: string; observedBy?: string } = {};
  await backfillRow(
    FAKE_SUPABASE,
    { lineUserId: LINE_OK, shopifyCustomerId: SHOPIFY },
    deps({
      appendLink: (async (_c: unknown, input: Record<string, unknown>) => {
        const left = input.left as { kind: string };
        const right = input.right as { kind: string };
        seen = {
          leftKind: left.kind,
          rightKind: right.kind,
          basis: input.basis as string,
          observedBy: input.observedBy as string,
        };
        return {
          ok: true,
          appended: true,
          subjectA: "A".repeat(26),
          subjectB: "B".repeat(26),
          leftSubjectId: "L".repeat(26),
          rightSubjectId: "R".repeat(26),
        };
      }) as unknown as BackfillDeps["appendLink"],
    }),
  );
  assertDeep(
    seen,
    {
      leftKind: "line_messaging_uid",
      rightKind: "shopify_customer_id",
      basis: BACKFILL_BASIS,
      observedBy: BACKFILL_OBSERVED_BY,
    },
    "正規経路に渡す引数が変わっている",
  );
});

console.log("\n=== 写せなかった理由を無言にしない（T-12）===");

await it("J-4 / retired / 主体不在 / 同一主体 をそれぞれ別の名前で数える", () => {
  assertEqual(classifyLink({ ok: false, reason: "j4_conflict" }), "j4_conflict", "j4");
  assertEqual(classifyLink({ ok: false, reason: "retired_subject" }), "retired_subject", "retired");
  assertEqual(classifyLink({ ok: false, reason: "same_subject" }), "already_same_subject", "same");
  assertEqual(
    classifyLink({ ok: false, reason: "subject_unavailable:edge_lookup_failed" }),
    "subject_unavailable",
    "subject_unavailable",
  );
  assertEqual(classifyLink({ ok: false, reason: "insert_failed" }), "insert_failed", "insert");
});

await it("J-4 で写せなかった行でも delivery の派生は続ける（link と delivery は別の失敗）", async () => {
  const r = await backfillRow(
    FAKE_SUPABASE,
    { lineUserId: LINE_OK, shopifyCustomerId: SHOPIFY },
    deps({
      appendLink: (async () => ({ ok: false, reason: "j4_conflict" })) as BackfillDeps["appendLink"],
    }),
  );
  assertEqual(r.link, "j4_conflict", "link の結末");
  assertEqual(r.delivery, "derived", "link が落ちたら delivery まで止めてしまっている");
});

console.log("\n=== 配信の宛先に形の違う値を入れない（E5 / delivery_identity の CHECK）===");

await it("Messaging userId 形式でない line_user_id では delivery を作りにいかない", async () => {
  let called = false;
  const r = await backfillRow(
    FAKE_SUPABASE,
    { lineUserId: "U_not_hex_0000000000000000000000", shopifyCustomerId: SHOPIFY },
    deps({
      upsertDelivery: (async () => {
        called = true;
        return { ok: true, updated: true };
      }) as BackfillDeps["upsertDelivery"],
    }),
  );
  assertEqual(r.delivery, "skipped_bad_form", "形の違う値を素通しした");
  assertTrue(!called, "upsertDeliveryIdentity を呼んでしまっている");
});

await it("link が張れた行では、解決済みの LINE 主体をそのまま使う（引き直さない）", async () => {
  let resolveCalls = 0;
  let usedSubject = "";
  await backfillRow(
    FAKE_SUPABASE,
    { lineUserId: LINE_OK, shopifyCustomerId: SHOPIFY },
    deps({
      resolveSubject: (async () => {
        resolveCalls += 1;
        return { subjectId: "S".repeat(26), issued: false };
      }) as unknown as BackfillDeps["resolveSubject"],
      upsertDelivery: (async (_c: unknown, p: { subjectId: string }) => {
        usedSubject = p.subjectId;
        return { ok: true, updated: true };
      }) as BackfillDeps["upsertDelivery"],
    }),
  );
  assertEqual(resolveCalls, 0, "同じ鍵を 2 回解決している");
  assertEqual(usedSubject, "L".repeat(26), "link が返した LINE 側の主体を使っていない");
});

await it("link が張れなかった行では引き直して delivery を作る", async () => {
  let resolveCalls = 0;
  const r = await backfillRow(
    FAKE_SUPABASE,
    { lineUserId: LINE_OK, shopifyCustomerId: SHOPIFY },
    deps({
      appendLink: (async () => ({
        ok: false,
        reason: "j4_conflict",
      })) as BackfillDeps["appendLink"],
      resolveSubject: (async () => {
        resolveCalls += 1;
        return { subjectId: "S".repeat(26), issued: false };
      }) as unknown as BackfillDeps["resolveSubject"],
    }),
  );
  assertEqual(resolveCalls, 1, "引き直していない");
  assertEqual(r.delivery, "derived", "delivery が作られていない");
});

console.log("\n=== 生の識別子をログに出さない（E5）===");

await it("結果に生値が残らない", async () => {
  const r = await backfillRow(
    FAKE_SUPABASE,
    { lineUserId: LINE_OK, shopifyCustomerId: SHOPIFY },
    deps(),
  );
  const serialized = JSON.stringify(r);
  assertTrue(!serialized.includes(LINE_OK), "生の LINE userId が結果に残っている");
  assertTrue(!serialized.includes(SHOPIFY), "生の Shopify 顧客番号が結果に残っている");
  assertEqual(mask(LINE_OK), "U012***def", "マスクの形");
});

console.log("\n=== 集計 ===");

await it("summarize は結末ごとに数え、抜けを作らない", () => {
  const rows: RowResult[] = [
    { line: "a", shopify: "b", link: "linked", delivery: "derived" },
    { line: "c", shopify: "d", link: "linked", delivery: "derived" },
    { line: "e", shopify: "f", link: "j4_conflict", delivery: "derived" },
    { line: "g", shopify: "h", link: "already_same_subject", delivery: "skipped_bad_form" },
  ];
  const s = summarize(rows);
  assertEqual(s.link.linked, 2, "linked");
  assertEqual(s.link.j4_conflict, 1, "j4");
  assertEqual(s.link.already_same_subject, 1, "same");
  assertEqual(s.link.insert_failed, 0, "insert_failed が 0 で出ていない");
  assertEqual(s.delivery.derived, 3, "derived");
  assertEqual(s.delivery.skipped_bad_form, 1, "skipped_bad_form");
});

console.log(
  `\n=== cdp-stage2-backfill.test: ${passed}/${total} passed, ${failures.length} failed ===`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
