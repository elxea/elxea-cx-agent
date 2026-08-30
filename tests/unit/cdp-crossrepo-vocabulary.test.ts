/**
 * Unit — 2 リポの語彙が食い違っていないこと（D3 / D4 の再発防止）
 *
 * ─ なぜ要るか ─
 *
 * 出来事を **送る側**（elxea-web-app）と **受ける側**（cx-agent の events gateway）は
 * 別のリポジトリにある。送る側が使う `event_type` / `channel` / `identifier_kind` が
 * 受ける側の登録簿に無いと、その出来事は `schema_ok = false` に落ちる（Stage 1 以降は
 * 捨てられこそしないが、**畳まれない** ので L1 にも解析にも出てこない）。
 *
 * これは実際に起きた壊れ方である。統合設計 §4 の D3・D4:
 *   D3 … 行動語彙が cx-agent 14 値 / web-app 型 10 値 / web-app zod 7 値の三分裂
 *   D4 … channel が zod 3 値 / 型 2 値 / route は "web" 固定 / 注文 webhook は "shopify" 実書込
 * どちらも「片側だけを見るテスト」を両側が持っていたために、**両方緑のまま**
 * 食い違い続けた。片側のテストは、片側の語彙が自己整合であることしか言えない。
 *
 * ─ 何をするか ─
 *
 * 送る側のソースから、実際に送っている語彙のリテラルを読み取り、受ける側の
 * 登録簿（`src/lib/cdp/event-vocabulary.ts`）が受理するかを突き合わせる。
 *
 * 送る側のリポジトリが手元に無ければ **SKIP する**（落とさない）。これは
 * cx-agent 単体でも `pnpm test:unit` が通り続けるようにするため。2 リポが揃う
 * 環境（開発者の手元・受入スイート）では実際に突合が走る。
 *
 * ─ 読み取りであってビルドではない ─
 *
 * web-app の TypeScript を import しない（Next.js 側の依存を cx-agent に持ち込む
 * ことになる）。ソースを文字列として読み、リテラルを正規表現で抜く。
 * 抜けなかったら **SKIP ではなく FAIL** にする — 「読めなかったから合格」は
 * この手の突合がいちばん静かに死ぬ形なので、読めないことは異常として扱う。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  isIdentifierKind,
  isKnownChannel,
  isKnownEventType,
  isWellFormedChannel,
  isWellFormedEventType,
  BEHAVIOR_ACTIONS,
} from "../../src/lib/cdp/event-vocabulary";

let total = 0;
let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(name: string, fn: () => void): void {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    failures.push({ name, error });
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${error}`);
  }
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/**
 * 送る側（web-app）のリポジトリを探す。
 *
 * 環境変数 > 隣（../elxea-web-app）の順。worktree で作業していると相対位置が
 * 変わるため、環境変数での明示指定を先に見る。
 */
function findWebApp(): string | null {
  const fromEnv = process.env.ELXEA_WEB_APP_PATH;
  if (fromEnv && existsSync(join(fromEnv, "lib/cdp"))) return fromEnv;
  const sibling = resolve(process.cwd(), "..", "elxea-web-app");
  if (existsSync(join(sibling, "lib/cdp"))) return sibling;
  return null;
}

/** 送る側のソースから、L0 へ送る 1 件分の語彙を抜く。 */
interface EmittedFact {
  file: string;
  eventType: string;
  /** `behavior.${action}` のようにテンプレートなら true。 */
  templated: boolean;
  channel: string;
}

function extractEmitted(root: string): EmittedFact[] {
  const files = ["lib/cdp/diagnosis.ts", "lib/cdp/behavior-fact.ts", "lib/cdp/survey-fact.ts"];
  const out: EmittedFact[] = [];

  for (const rel of files) {
    const p = join(root, rel);
    if (!existsSync(p)) throw new Error(`送る側のファイルが無い: ${rel}（配置が変わった？）`);
    const src = readFileSync(p, "utf8");

    // event_type: "..." または event_type: `...${...}`
    const et = /event_type:\s*(?:"([^"]+)"|`([^`]+)`)/.exec(src);
    if (!et) throw new Error(`${rel} から event_type を読み取れない（形が変わった？）`);
    const raw = et[1] ?? et[2];
    const templated = raw.includes("${");

    const ch = /channel:\s*"([^"]+)"/.exec(src);
    if (!ch) throw new Error(`${rel} から channel を読み取れない（形が変わった？）`);

    out.push({ file: rel, eventType: raw, templated, channel: ch[1] });
  }
  return out;
}

/** 送る側が使う identifier_kind のリテラル。 */
function extractIdentifierKinds(root: string): string[] {
  const p = join(root, "lib/cdp/behavior-fact.ts");
  const src = readFileSync(p, "utf8");
  // { kind: "a" | "b" | "c"; value: string } の union を読む
  const m = /\|\s*\{\s*kind:\s*((?:"[a-z_]+"\s*\|?\s*)+);/.exec(src);
  if (!m) throw new Error("behavior-fact.ts から identifier_kind の union を読み取れない");
  const kinds = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  if (kinds.length === 0) throw new Error("identifier_kind が 1 つも読み取れない");
  return kinds;
}

function main(): void {
  const root = findWebApp();
  if (!root) {
    console.log("[SKIP] 送る側（elxea-web-app）が手元に無いため、2 リポ語彙突合は行わない。");
    console.log("       突合したい場合: ELXEA_WEB_APP_PATH=<path> npx tsx tests/unit/cdp-crossrepo-vocabulary.test.ts");
    process.exit(0);
  }
  console.log(`  （送る側: ${root}）`);

  let emitted: EmittedFact[];
  let kinds: string[];
  try {
    emitted = extractEmitted(root);
    kinds = extractIdentifierKinds(root);
  } catch (e) {
    // 読めないことは異常。「読めなかったから合格」にしない。
    console.log(`  [FAIL] 送る側の語彙を読み取れない: ${e instanceof Error ? e.message : e}`);
    console.log("\n=== cdp-crossrepo-vocabulary.test: 0/1 passed, 1 failed ===");
    process.exit(1);
  }

  for (const f of emitted) {
    if (f.templated) {
      // `behavior.${action}` 形式。action の取りうる値は受ける側の登録簿が正本なので、
      // 「接頭辞が受ける側の形に合っている」ことと「登録簿の全 action が通る」ことを見る。
      it(`${f.file}: テンプレート event_type '${f.eventType}' の接頭辞が受ける側の形に合う`, () => {
        const prefix = f.eventType.split("${")[0];
        assertTrue(
          prefix === "behavior.",
          `接頭辞が 'behavior.' でない: '${prefix}'。受ける側の behaviorEventType と食い違う`,
        );
        const bad = BEHAVIOR_ACTIONS.filter((a) => !isKnownEventType(`${prefix}${a}`));
        assertTrue(
          bad.length === 0,
          `受ける側の登録簿にある action が、この接頭辞では既知にならない: ${bad.join(", ")}`,
        );
      });
    } else {
      it(`${f.file}: event_type '${f.eventType}' が受ける側の登録簿にある`, () => {
        assertTrue(
          isWellFormedEventType(f.eventType),
          `event_type の形が受ける側の規則に合わない: '${f.eventType}'`,
        );
        assertTrue(
          isKnownEventType(f.eventType),
          `受ける側の KNOWN_EVENT_TYPES に無い: '${f.eventType}'。` +
            `このまま送ると schema_ok=false に落ち、L1 にも解析にも出てこない`,
        );
      });
    }

    it(`${f.file}: channel '${f.channel}' が受ける側の登録簿にある`, () => {
      assertTrue(isWellFormedChannel(f.channel), `channel の形が合わない: '${f.channel}'`);
      assertTrue(
        isKnownChannel(f.channel),
        `受ける側の KNOWN_CHANNELS に無い: '${f.channel}'（D4 の再発）`,
      );
    });
  }

  it(`identifier_kind ${kinds.length} 種がすべて受ける側で解釈できる`, () => {
    const bad = kinds.filter((k) => !isIdentifierKind(k));
    assertTrue(
      bad.length === 0,
      `受ける側の IDENTIFIER_KINDS に無い: ${bad.join(", ")}。` +
        `識別子の種類は **閉じている**（契約 §3）ので、知らない種類は主体に解決されず 400 になる`,
    );
  });

  it("送る側は生の LINE userId を identifier_kind に使っていない（E5）", () => {
    assertTrue(
      !kinds.includes("line_messaging_uid"),
      "web-app が line_messaging_uid を送っている。生の Messaging userId は " +
        "delivery_identity だけが持つ決まり（E5）で、web-app は LINE Login 側の " +
        "line_login_uid しか知らないはず",
    );
  });

  console.log(`\n=== cdp-crossrepo-vocabulary.test: ${passed}/${total} passed, ${failures.length} failed ===`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main();
