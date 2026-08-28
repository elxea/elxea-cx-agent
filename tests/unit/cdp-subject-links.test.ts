/**
 * Unit — Stage 2 の判断だけを DB 抜きで固定する
 *
 * ここで固定するのは「DB にも HTTP にも触れない部分」だけ:
 *   - 無向辺の正規化（orderPair）
 *   - DB の失敗を数えられる名前に読み替える（classifyLinkError）
 *   - RPC の戻りの読み方（readResolution）— **壊れた形を中途半端に読まない**
 *   - 読み出し集合の組み立て（unionCrossChannelUserIds）— **旧を 1 つも落とさない**
 *
 * 配線そのもの（トリガ・連結成分・消去）は tests/db/*.db.test.ts が実 DB で見る。
 * ここは「実 DB を用意しなくても壊れたら分かる」層。
 */

import {
  LINK_BASES,
  orderPair,
  classifyLinkError,
} from "../../src/lib/cdp/subject-links";
import { readResolution } from "../../src/lib/cdp/canonical";
import { unionCrossChannelUserIds } from "../../src/lib/supabase";

let total = 0;
let passed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
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

console.log("\n=== SEC-1: 根拠の語彙に email_equality が無い ===");

it("LINK_BASES は 3 値で、email_equality を含まない", () => {
  assertDeep(
    [...LINK_BASES],
    ["liff_id_token", "line_account_link", "anonymous_promotion"],
    "根拠の語彙が変わっている",
  );
  assertTrue(
    !(LINK_BASES as readonly string[]).includes("email_equality"),
    "email_equality が語彙に入っている（SEC-1 を取り消すことになる）",
  );
});

console.log("\n=== 無向辺の正規化 ===");

it("orderPair は常に小さいほうを先に返す（向きを持たない）", () => {
  assertDeep(orderPair("B", "A"), ["A", "B"], "逆順が正規化されていない");
  assertDeep(orderPair("A", "B"), ["A", "B"], "正順が変わってしまっている");
});

console.log("\n=== DB の失敗を数えられる名前にする ===");

it("J-4 のトリガ由来は j4_conflict になる", () => {
  assertEqual(
    classifyLinkError({ code: "23514", message: "J-4 violation: 1 人の Shopify 顧客に…" }),
    "j4_conflict",
    "J-4 が別の名前で数えられている",
  );
});

it("basis のホワイトリスト違反は j4_conflict にしない（別の意味を同じ名前で数えない）", () => {
  assertEqual(
    classifyLinkError({
      code: "23514",
      message: 'new row violates check constraint "subject_links_basis_allowed"',
    }),
    "insert_failed",
    "根拠違反が J-4 として数えられている",
  );
});

it("消去済みの主体を結ぼうとした失敗は retired_subject", () => {
  assertEqual(
    classifyLinkError({ message: "retired subject: 消去済みの主体を…" }),
    "retired_subject",
    "retired が別の名前になっている",
  );
});

console.log("\n=== RPC の戻りの読み方（壊れた形を中途半端に読まない）===");

it("link が 0 本なら linked=false（連携していない人の分岐が変わらない）", () => {
  const r = readResolution({
    found: true,
    canonical_id: "X",
    member_count: 1,
    link_count: 0,
    identifier_values: ["U1"],
  });
  assertEqual(r.resolved, true, "resolved でない");
  assertEqual(r.linked, false, "link 0 本なのに linked=true");
  assertDeep(r.userRefs, ["U1"], "自分の鍵が返っていない");
});

it("link があれば linked=true・鍵が全部返る", () => {
  const r = readResolution({
    found: true,
    canonical_id: "X",
    member_count: 3,
    link_count: 2,
    identifier_values: ["U1", "700", "sess"],
  });
  assertEqual(r.linked, true, "link があるのに linked=false");
  assertDeep(r.userRefs, ["U1", "700", "sess"], "鍵が欠けている");
});

it("found=false は resolved=false（旧 join だけで読む側に倒れる）", () => {
  const r = readResolution({ found: false, reason: "subject_not_found" });
  assertEqual(r.resolved, false, "resolved になってしまっている");
  assertEqual(r.linked, false, "linked になってしまっている");
  assertEqual(r.reason, "subject_not_found", "理由が落ちている");
  assertDeep(r.userRefs, [], "鍵が返っている");
});

it("形が壊れていたら resolved=false（足りない集合で会話を引かない）", () => {
  for (const broken of [null, undefined, "nope", 42, { found: true }, { found: true, identifier_values: "x" }]) {
    const r = readResolution(broken);
    assertEqual(r.resolved, false, `壊れた形を読んでしまっている: ${JSON.stringify(broken)}`);
    assertDeep(r.userRefs, [], `壊れた形から鍵が出ている: ${JSON.stringify(broken)}`);
  }
});

it("文字列でない鍵・空文字は落とす", () => {
  const r = readResolution({
    found: true,
    link_count: 1,
    identifier_values: ["U1", "", null, 3, "sess"],
  });
  assertDeep(r.userRefs, ["U1", "sess"], "ゴミが混ざっている");
});

console.log("\n=== 読み出し集合の組み立て（旧を 1 つも落とさない）===");

it("extraUserIds を渡さなければ Stage 2 以前と同じ集合になる", () => {
  const legacy = {
    line_user_id: "U1",
    web_session_id: "sess",
    shopify_customer_id: "700",
  };
  assertDeep(
    unionCrossChannelUserIds({ unifiedUserId: "700", legacy, originalSessionId: "sess2" }),
    ["700", "U1", "sess", "sess2"],
    "旧の集合が変わっている",
  );
});

it("canonical の分は足されるだけで、旧の要素は 1 つも消えない", () => {
  const legacy = { line_user_id: "U1", web_session_id: null, shopify_customer_id: "700" };
  const before = unionCrossChannelUserIds({ unifiedUserId: "700", legacy });
  const after = unionCrossChannelUserIds({
    unifiedUserId: "700",
    legacy,
    extraUserIds: ["sessX", "U1", "700"],
  });
  for (const v of before) {
    assertTrue(after.includes(v), `旧の ${v} が落ちている`);
  }
  assertDeep(after, ["700", "U1", "sessX"], "重複が畳まれていない / 順序が崩れている");
});

it("空文字・重複・null は入らない（IN 句にゴミを送らない）", () => {
  assertDeep(
    unionCrossChannelUserIds({
      unifiedUserId: "700",
      legacy: { line_user_id: "", web_session_id: null, shopify_customer_id: "700" },
      extraUserIds: ["", "700", "U9", "U9"],
    }),
    ["700", "U9"],
    "ゴミが混ざっている",
  );
});

console.log(`\n=== cdp-subject-links.test: ${passed}/${total} passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
