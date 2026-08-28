/**
 * Unit Tests — セグメント配信の SQL 化 / 受け口 / 除外条件（CDP 統合 Stage 4）
 *
 * ネットワークに触れない（fake Supabase / fake Firestore 行を注入）。検証範囲:
 *
 *   - 新旧の宛先が一致する（**合成データ N=24 人**・連携 / 未連携 / 友だち解除を含む）
 *   - shadow は配信の挙動を 1 つも変えない（旧が決めたものがそのまま返る）
 *   - cdp モードは新が引けなければ **送らない**（fail-closed。旧に黙って落ちない）
 *   - 受け口の payload の形（壊れた形は schema_ok=false 側に倒れる・捨てはしない）
 *   - 点の増減は「前後の差」で採る（押し替えの取り消しでも L0 と Firestore がずれない）
 *   - 「もういらない」は L1 由来でも割当に **実効**（点数で覆らない）
 *   - 観測は空虚合格しない（1 本も比べていない日を「一致した日」と言わない）
 *
 * 使用: npx tsx tests/unit/cdp-stage4-segment.test.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../src/index";
import {
  compareTargets,
  resolveCdpSegmentTargets,
  resolveSegmentMode,
} from "../../src/lib/cdp/segment-resolver";
import { judgeAgreement } from "../../src/lib/cdp/stage4-parity";
import {
  normalizeDelta,
  personaDeltaFromScores,
  recordExclusion,
  recordSafetyDeclaration,
  recordPersonaSignal,
} from "../../src/lib/cdp/profile-intake";
import { readExclusions, unionNoneOf } from "../../src/lib/cdp/subject-profile";
import { isWellFormedPayload, isProfileEventType } from "../../src/lib/cdp/event-vocabulary";
import { resolveTargetsWithCdp } from "../../src/lib/delivery-runtime";
import {
  resolveTargets,
  type LineUserPersonaRow,
  type LinkageRow,
  type PersonaRow,
  type TargetResolverDeps,
} from "../../src/lib/target-resolver";
import { s1Engine } from "../../src/lib/roji/assignment/s1-engine";
import type { Candidate } from "../../src/lib/roji/assignment/types";
import type { TeaItem } from "../../src/lib/tea-menu";

let total = 0;
let passed = 0;
const failures: string[] = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}

const lineUid = (n: number) => `U${n.toString(16).padStart(32, "0")}`;

// ---------------------------------------------------------------------------
// 合成データ — 1 つの母集団から「旧が見る 3 つの棚」と「新が見る L1」を両方作る
//
// ここが検証の芯である: **同じ事実**から旧の入力（Firestore 2 コレクション +
// customer_linkages）と新の入力（L1 の SQL が返す宛先）を作り、両者が同じ集合に
// なることを見る。片方を手で書くと「手で書いたとおりになった」しか言えない。
// ---------------------------------------------------------------------------

interface Person {
  /** 連携済みなら Shopify 顧客番号を持つ。 */
  shopifyCustomerId: string | null;
  lineUserId: string;
  persona: "serenity" | "explorer" | "sensory" | null;
  unfollowed: boolean;
  /** 「もう送らないで」の申告。新旧の一致を見るケースからは外す（下記）。 */
  suppressed: boolean;
}

/** 24 人（連携 12 / 未連携 12。うち友だち解除 4・ペルソナ無し 3）。 */
function makePopulation(): Person[] {
  const personas = ["serenity", "explorer", "sensory"] as const;
  const out: Person[] = [];
  for (let i = 1; i <= 24; i += 1) {
    const linked = i % 2 === 0;
    out.push({
      shopifyCustomerId: linked ? String(1000 + i) : null,
      lineUserId: lineUid(i),
      persona: i % 8 === 0 ? null : personas[i % 3],
      unfollowed: i % 6 === 0,
      suppressed: false,
    });
  }
  return out;
}

/** 旧 resolver が読む 3 つの棚。 */
function legacyDeps(pop: Person[]): TargetResolverDeps {
  const linkages: LinkageRow[] = pop
    .filter((p) => p.shopifyCustomerId !== null)
    .map((p) => ({
      shopifyCustomerId: p.shopifyCustomerId as string,
      lineUserId: p.lineUserId,
      unfollowed: p.unfollowed,
      optedOut: false,
    }));

  // users/{shopifyId} は連携済みの人のカルテ。
  const personaUsers: PersonaRow[] = pop
    .filter((p) => p.shopifyCustomerId !== null && p.persona !== null)
    .map((p) => ({
      shopifyCustomerId: p.shopifyCustomerId as string,
      persona: p.persona as PersonaRow["persona"],
    }));

  // lineUsers/{lineUserId} は未連携の人のカルテ（T-9 の 2 冊目）。
  const lineUsers: LineUserPersonaRow[] = pop
    .filter((p) => p.shopifyCustomerId === null && p.persona !== null)
    .map((p) => ({ lineUserId: p.lineUserId, persona: p.persona as PersonaRow["persona"] }));

  return {
    loadLinkages: async () => linkages,
    loadPersonaUsers: async (persona) => personaUsers.filter((r) => r.persona === persona),
    loadPersonaLineUsers: async (persona) => lineUsers.filter((r) => r.persona === persona),
    broadcastEstimate: async () => null,
    loadAllowlistUserIds: async () => [],
  };
}

/**
 * 新 resolver が読む L1（migration 046 の cdp_segment_line_targets が返す形）。
 *
 * SQL 側の判定を **写す**のではなく、SQL と同じ条件（セグメントに入っている /
 * 宛先がある / 友だち解除でない / 停止申告が無い）をこの fake が満たすように作る。
 * SQL 本体の正しさは tests/db/cdp-stage4-l1.db.test.ts が実 DB で見る。
 */
function fakeCdpSupabase(pop: Person[], opts?: { fail?: string }): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (opts?.fail) return { data: null, error: { message: opts.fail } };
      if (fn !== "cdp_segment_line_targets") {
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      }
      const persona = args.p_persona as string;
      const ids = pop
        .filter((p) => p.persona === persona && !p.unfollowed && !p.suppressed)
        .map((p) => p.lineUserId)
        .sort();
      return {
        data: {
          persona,
          count: ids.length,
          user_ids: ids,
          truncated: false,
          excluded: { unfollowed: pop.filter((p) => p.persona === persona && p.unfollowed).length },
        },
        error: null,
      };
    },
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// 1. 新旧の配信対象が一致する（Stage 4 の完了条件そのもの）
// ---------------------------------------------------------------------------

it("N=24 の合成データで、新旧の配信対象が 3 ペルソナとも完全一致する", async () => {
  const pop = makePopulation();
  const deps = legacyDeps(pop);
  const supabase = fakeCdpSupabase(pop);

  let checked = 0;
  for (const persona of ["serenity", "explorer", "sensory"] as const) {
    const legacy = await resolveTargets({ kind: "persona", persona }, deps);
    assertTrue(legacy.kind === "multicast", `${persona}: 旧が対象を出せている`);
    const cdp = await resolveCdpSegmentTargets(supabase, persona);
    assertTrue(cdp.ok, `${persona}: 新が対象を出せている`);
    if (legacy.kind !== "multicast" || !cdp.ok) continue;

    const agreement = compareTargets(legacy.userIds, cdp.userIds);
    assertEqual(agreement.legacyOnly, 0, `${persona}: 旧にだけ居る人`);
    assertEqual(agreement.cdpOnly, 0, `${persona}: 新にだけ居る人`);
    assertTrue(agreement.inAgreement, `${persona}: 一致`);
    assertTrue(agreement.both > 0, `${persona}: 0 人同士の空虚な一致ではない`);
    checked += agreement.both;
  }
  // 24 人中: ペルソナ無し 3 人・友だち解除 4 人を除いた分が対象。
  assertTrue(checked >= 17, `対象総数が想定どおり（実測 ${checked}）`);
});

it("未連携の人（lineUsers 側だけに居る人）も新 resolver が拾う（T-9 の置き換えが成立する）", async () => {
  const pop = makePopulation();
  const unlinked = pop.filter((p) => p.shopifyCustomerId === null && p.persona && !p.unfollowed);
  assertTrue(unlinked.length > 0, "未連携でペルソナを持つ人が母集団に居る");

  const supabase = fakeCdpSupabase(pop);
  const cdp = await resolveCdpSegmentTargets(supabase, unlinked[0].persona as string);
  assertTrue(cdp.ok, "新が引けた");
  if (!cdp.ok) return;
  assertTrue(cdp.userIds.includes(unlinked[0].lineUserId), "未連携の人が新の宛先に居る");
});

it("友だち解除の人はどちらの経路でも宛先に入らない", async () => {
  const pop = makePopulation();
  const gone = pop.filter((p) => p.unfollowed && p.persona);
  assertTrue(gone.length > 0, "友だち解除の人が母集団に居る");

  const deps = legacyDeps(pop);
  const supabase = fakeCdpSupabase(pop);
  for (const p of gone) {
    const legacy = await resolveTargets({ kind: "persona", persona: p.persona! }, deps);
    const cdp = await resolveCdpSegmentTargets(supabase, p.persona!);
    if (legacy.kind === "multicast") {
      assertTrue(!legacy.userIds.includes(p.lineUserId), "旧に居ない");
    }
    if (cdp.ok) assertTrue(!cdp.userIds.includes(p.lineUserId), "新に居ない");
  }
});

// ---------------------------------------------------------------------------
// 2. モード（並走 / 切替）
// ---------------------------------------------------------------------------

it("モードの既定は shadow（未設定・未知の値も shadow に倒れる）", () => {
  assertEqual(resolveSegmentMode(undefined), "shadow", "未設定");
  assertEqual(resolveSegmentMode(""), "shadow", "空");
  assertEqual(resolveSegmentMode("nonsense"), "shadow", "未知");
  assertEqual(resolveSegmentMode("off"), "off", "off");
  assertEqual(resolveSegmentMode("CDP"), "cdp", "大文字も読む");
});

it("shadow は配信の挙動を 1 つも変えない（新が壊れていても旧の答えがそのまま返る）", async () => {
  const pop = makePopulation();
  const deps = legacyDeps(pop);
  const env = { CDP_SEGMENT_MODE: "shadow" } as unknown as Env;
  // 新が完全に落ちる状況を作る（046 未適用と同じ）。
  const supabase = fakeCdpSupabase(pop, { fail: "function does not exist" });

  const legacy = await resolveTargets({ kind: "persona", persona: "serenity" }, deps);
  const via = await resolveTargetsWithCdp(
    env,
    supabase as never,
    { kind: "persona", persona: "serenity" },
    deps,
  );
  assertEqual(via.kind, legacy.kind, "種別が同じ");
  if (via.kind === "multicast" && legacy.kind === "multicast") {
    assertEqual(via.userIds.join(","), legacy.userIds.join(","), "宛先が 1 人も変わらない");
  }
});

it("cdp モードは新が引けなければ送らない（旧に黙って落ちない）", async () => {
  const pop = makePopulation();
  const deps = legacyDeps(pop);
  const env = { CDP_SEGMENT_MODE: "cdp" } as unknown as Env;
  const supabase = fakeCdpSupabase(pop, { fail: "function does not exist" });

  const via = await resolveTargetsWithCdp(
    env,
    supabase as never,
    { kind: "persona", persona: "serenity" },
    deps,
  );
  assertEqual(via.kind, "error", "fail-closed（error になる）");
  if (via.kind === "error") {
    assertTrue(via.reason.includes("fail-closed"), "理由に fail-closed と書いてある");
  }
});

it("cdp モードは新の集合をそのまま宛先にする", async () => {
  const pop = makePopulation();
  const deps = legacyDeps(pop);
  const env = { CDP_SEGMENT_MODE: "cdp" } as unknown as Env;
  const supabase = fakeCdpSupabase(pop);

  const via = await resolveTargetsWithCdp(
    env,
    supabase as never,
    { kind: "persona", persona: "explorer" },
    deps,
  );
  assertTrue(via.kind === "multicast", "multicast で返る");
  const cdp = await resolveCdpSegmentTargets(supabase, "explorer");
  if (via.kind === "multicast" && cdp.ok) {
    assertEqual(via.userIds.join(","), cdp.userIds.join(","), "新の集合と同じ");
  }
});

it("全員配信・社内 allowlist は並走の対象外（旧の経路をそのまま通る）", async () => {
  const pop = makePopulation();
  const deps: TargetResolverDeps = {
    ...legacyDeps(pop),
    broadcastEstimate: async () => 42,
    loadAllowlistUserIds: async () => [lineUid(900)],
  };
  const env = { CDP_SEGMENT_MODE: "cdp" } as unknown as Env;
  // 新が落ちる状態でも、全員配信は影響を受けない。
  const supabase = fakeCdpSupabase(pop, { fail: "boom" });

  const all = await resolveTargetsWithCdp(env, supabase as never, { kind: "all" }, deps);
  assertEqual(all.kind, "broadcast", "全員配信は broadcast のまま");

  const allow = await resolveTargetsWithCdp(
    env,
    supabase as never,
    { kind: "allowlist", userIds: [] },
    deps,
  );
  assertEqual(allow.kind, "multicast", "社内 allowlist は multicast のまま");
});

// ---------------------------------------------------------------------------
// 3. 突合のロジック
// ---------------------------------------------------------------------------

it("集合比較は順序と重複を無視し、宛先そのものを返さない", () => {
  const a = compareTargets(["a", "b", "b", "c"], ["c", "b", "a"]);
  assertTrue(a.inAgreement, "同じ集合");
  assertEqual(a.legacyCount, 3, "重複は畳む");

  const b = compareTargets(["a", "b"], ["b", "c"]);
  assertEqual(b.legacyOnly, 1, "旧にだけ");
  assertEqual(b.cdpOnly, 1, "新にだけ");
  assertTrue(!b.inAgreement, "不一致");
  assertTrue(!("userIds" in (b as Record<string, unknown>)), "宛先そのものは返さない");
});

it("1 本も比べていない日を「一致した日」と言わない（空虚合格の封鎖）", () => {
  const l1ok = { in_agreement: true };
  assertTrue(!judgeAgreement(l1ok, undefined), "比較が無い日は false");
  assertTrue(!judgeAgreement(l1ok, {}), "比較が 0 本の日も false");
  assertTrue(!judgeAgreement({ in_agreement: false }, { p: okAgreement() }), "L1 が不一致なら false");
  assertTrue(judgeAgreement(l1ok, { p: okAgreement() }), "両方そろって初めて true");
});

function okAgreement() {
  return { legacyCount: 1, cdpCount: 1, legacyOnly: 0, cdpOnly: 0, both: 1, inAgreement: true };
}

// ---------------------------------------------------------------------------
// 4. 受け口（payload の形と、L0 への積み方）
// ---------------------------------------------------------------------------

it("L1 を動かす出来事は語彙に載っている", () => {
  for (const t of [
    "persona.signal_applied",
    "persona.baseline_imported",
    "exclusion.set",
    "exclusion.cleared",
    "safety.declared",
    "notify.preference_set",
    "notify.suppressed",
    "notify.resumed",
    "profile.override",
  ]) {
    assertTrue(isProfileEventType(t), `${t} が L1 を動かす語彙にある`);
  }
  assertTrue(!isProfileEventType("behavior.purchase"), "行動ログは L1 を動かす語彙ではない");
});

it("壊れた形は schema_ok=false 側に倒れる（L1 が畳まない）", () => {
  assertTrue(
    isWellFormedPayload("exclusion.set", { ref: "10023" }),
    "銘柄番号があれば読める",
  );
  assertTrue(!isWellFormedPayload("exclusion.set", { ref: "  " }), "空の銘柄番号は読めない");
  assertTrue(!isWellFormedPayload("exclusion.set", {}), "銘柄番号が無いものは読めない");

  assertTrue(
    isWellFormedPayload("persona.signal_applied", { source: "survey", delta: { serenity: 3 } }),
    "出所と増減があれば読める",
  );
  assertTrue(
    !isWellFormedPayload("persona.signal_applied", { source: "survey", delta: { serenity: "3" } }),
    "増減が数値でないものは読めない",
  );
  assertTrue(
    !isWellFormedPayload("persona.signal_applied", { delta: { serenity: 3 } }),
    "出所が無いものは読めない",
  );

  assertTrue(isWellFormedPayload("safety.declared", { tags: ["allergy"] }), "申告があれば読める");
  assertTrue(!isWellFormedPayload("safety.declared", { tags: [] }), "空の申告は読めない");

  assertTrue(isWellFormedPayload("notify.resumed", {}), "再開は payload を要らない");
  // L1 を動かさない出来事の形は問わない（既存 5 経路の payload をここに写さない）。
  assertTrue(isWellFormedPayload("behavior.purchase", { anything: 1 }), "行動ログは形を問わない");
});

it("点の増減は「前後の差」で採る（押し替えの取り消しでもずれない）", () => {
  // 押し替え: explorer を取り消して sensory を足す（合計は動く量が違う）。
  const before = { serenity: 0, explorer: 3, sensory: 0 };
  const after = { serenity: 0, explorer: 0, sensory: 3 };
  const delta = personaDeltaFromScores(before, after);
  assertEqual(delta.explorer, -3, "取り消した分がマイナスで出る");
  assertEqual(delta.sensory, 3, "足した分がプラスで出る");
  assertTrue(!("serenity" in delta), "動かなかった軸は出ない");

  assertEqual(Object.keys(personaDeltaFromScores(before, before)).length, 0, "同じなら空");
  assertEqual(Object.keys(normalizeDelta({ serenity: 0 })).length, 0, "0 の軸は落ちる");
});

it("増減が空なら L0 に 1 行も積まない（意味のない行を作らない）", async () => {
  const calls: unknown[] = [];
  const supabase = fakeInsertOnly(calls);
  const res = await recordPersonaSignal(
    supabase,
    { identifier: { kind: "line_messaging_uid", value: lineUid(1) }, source: "t" },
    { source: "survey", delta: { serenity: 0 } },
  );
  assertTrue(!res.stored, "積んでいない");
  assertEqual(res.reason, "empty_delta", "理由が付く");
  assertEqual(calls.length, 0, "insert が呼ばれていない");
});

it("受け口は L0 に積む（安全申告・もういらない）", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const supabase = fakeInsertOnly(calls);
  const ctx = {
    identifier: { kind: "line_messaging_uid" as const, value: lineUid(2) },
    source: "cx-agent.test",
  };

  await recordSafetyDeclaration(supabase, ctx, { tags: ["allergy"], hasFreeText: true });
  await recordExclusion(supabase, ctx, { ref: "10023" });

  assertEqual(calls.length, 2, "2 行積んだ");
  assertEqual(calls[0].event_type, "safety.declared", "安全申告");
  assertEqual(calls[1].event_type, "exclusion.set", "もういらない");
  // 自由記述の本文は L0 に載せない（有無だけ）。
  const p0 = calls[0].payload as Record<string, unknown>;
  assertEqual(p0.has_free_text, true, "有無だけを載せる");
  assertTrue(!("free_text" in p0), "本文は載せない");
  // 生の LINE userId は payload にも冪等キーにも入らない（E5）。
  assertTrue(
    !JSON.stringify(calls[0]).includes(lineUid(2)),
    "生の LINE userId が行のどこにも入っていない",
  );
});

/** insert だけを見る最小の fake（主体は固定で返す）。 */
function fakeInsertOnly(sink: unknown[]): SupabaseClient {
  return {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === "customer_events") sink.push(row);
        return { error: null };
      },
      upsert: async () => ({ error: null }),
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: async () => ({
              data: [{ subject_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
              error: null,
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// 5. 除外条件が割当に実効（Stage 4 のもう 1 つの完了条件）
// ---------------------------------------------------------------------------

it("exclusions の jsonb は欠け・壊れに強い（部分的に読まない）", () => {
  const ok = readExclusions({
    tea_refs: ["10023", " 10024 ", ""],
    safety_tags: ["allergy"],
    broadcast_suppressed: true,
  });
  assertEqual(ok.teaRefs.join(","), "10023,10024", "空白は落として詰める");
  assertEqual(ok.broadcastSuppressed, true, "停止申告");

  const broken = readExclusions("nonsense");
  assertEqual(broken.teaRefs.length, 0, "壊れた形は空");
  assertEqual(broken.broadcastSuppressed, false, "壊れた形で止めない");
});

it("「もういらない」はカルテと L1 の和を採る（片方の申告を落とさない）", () => {
  assertEqual(unionNoneOf(["10023"], ["10024"]).join(","), "10023,10024", "両方残る");
  assertEqual(unionNoneOf(["10023"], ["10023"]).join(","), "10023", "重複は畳む");
  assertEqual(unionNoneOf(null, undefined).length, 0, "空同士");
});

it("L1 由来の「もういらない」が割当に実効（点数で覆らない）", () => {
  const teas: TeaItem[] = [
    tea("10001", ["緑茶"]),
    tea("10002", ["緑茶"]),
    tea("10003", ["緑茶"]),
    tea("10004", ["緑茶"]),
    tea("10005", ["緑茶"]),
    tea("10006", ["緑茶"]),
    tea("10007", ["緑茶"]),
  ];
  const candidates: Candidate[] = teas.map((t) => ({ kind: "tea", tea: t }));

  // L1 にだけ「もういらない」がある人（カルテ側は空）。
  const result = s1Engine.assign({
    period: "2026-09",
    karte: {
      persona: "serenity",
      tasteProfile: null,
      teaRequests: { noneOf: [] },
      exclusions: { teaRefs: ["10003"], safetyTags: [] },
    },
    candidates,
    recentLedger: [],
  });

  assertTrue(
    !result.teas.some((t) => t.number === "10003"),
    "L1 で外した銘柄が選ばれていない",
  );
  assertTrue(
    result.excluded.some((e) => e.ref.number === "10003" && e.reason === "none_of"),
    "外した理由が none_of として残る",
  );

  // 「また入れてほしい」に同じ銘柄があっても、もういらないが勝つ（設計 3-6）。
  const conflict = s1Engine.assign({
    period: "2026-09",
    karte: {
      persona: "serenity",
      tasteProfile: null,
      teaRequests: { moreOf: ["10003"], noneOf: [] },
      exclusions: { teaRefs: ["10003"], safetyTags: [] },
    },
    candidates,
    recentLedger: [],
  });
  assertTrue(
    !conflict.teas.some((t) => t.number === "10003"),
    "希望より「もういらない」が勝つ",
  );
});

function tea(number: string, flavorProfiles: string[]): TeaItem {
  return {
    id: `page-${number}`,
    number,
    name: `茶${number}`,
    category: "緑茶",
    flavorProfiles,
    descShort: "",
    howToBrew: "",
    temp: "",
    time: "",
    water: "",
    enjoy: "",
  } as unknown as TeaItem;
}

// --- runner -----------------------------------------------------------------

async function run() {
  console.log("\n=== cdp-stage4-segment.test ===\n");
  for (const { name, fn } of queue) {
    total += 1;
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  [FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(
    `\n=== cdp-stage4-segment.test: ${passed}/${total} passed, ${failures.length} failed ===`,
  );
  if (failures.length > 0) process.exit(1);
}

void run();
