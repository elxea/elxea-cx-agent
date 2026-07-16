/**
 * Unit Tests — ユーザー向けブランド文言の正本整合（禁止語リグレッション）
 *
 * 監査（2026-07-13）で確定した非正本文言の再混入を機械的に防ぐ。
 * ユーザー向けの runtime 文字列（system-prompt / ⑤about / ウェルカム / オンボーディング /
 * 配信テンプレ / brand-copy 定数）に、以下の禁止語が現れないことを固定する:
 *   「エルシア」「鹿児島を中心」「スキンケア」「合同会社」「静かな豊かさ」
 * さらに正本の値（読み仮名エルクシア / 株式会社elxea / タグライン）が入っていることも確認する。
 *
 * 正本: elxea-brand-context skill / About elxea / Corporate Info DB（brand-copy.ts のヘッダ参照）。
 * 使用: npx tsx tests/unit/brand-copy.test.ts
 */

import { SYSTEM_PROMPT } from "../../src/agent/system-prompt";
import {
  buildAboutMessage,
  buildConsultationPrompt,
  buildSubscriptionMessage,
} from "../../src/lib/menu-actions";
import { BROADCAST_TEMPLATES } from "../../src/lib/broadcast-templates";
import {
  BRAND_NAME_READING,
  COMPANY_NAME,
  BRAND_TAGLINE,
  BRAND_STATEMENT_SHORT,
  ABOUT_BLURB,
  WELCOME_INTRO,
  ONBOARDING_EXPLORE_INTRO,
  ONBOARDING_ABOUT_BODY,
  SUPPORT_EMAIL,
  DORMANT_REENGAGEMENT_MESSAGE,
} from "../../src/lib/brand-copy";

let total = 0;
let passed = 0;
const queue: Array<{ name: string; fn: () => void }> = [];
function it(name: string, fn: () => void) {
  queue.push({ name, fn });
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

/** ユーザー向け runtime 文字列を全て集める。 */
const USER_FACING: Array<{ label: string; text: string }> = [
  { label: "SYSTEM_PROMPT", text: SYSTEM_PROMPT },
  { label: "buildAboutMessage", text: buildAboutMessage() },
  { label: "buildConsultationPrompt", text: buildConsultationPrompt().text },
  { label: "buildSubscriptionMessage(subscriber)", text: buildSubscriptionMessage("subscriber") },
  { label: "buildSubscriptionMessage(generic)", text: buildSubscriptionMessage("generic") },
  { label: "ABOUT_BLURB", text: ABOUT_BLURB },
  { label: "WELCOME_INTRO", text: WELCOME_INTRO },
  { label: "ONBOARDING_EXPLORE_INTRO", text: ONBOARDING_EXPLORE_INTRO },
  { label: "ONBOARDING_ABOUT_BODY", text: ONBOARDING_ABOUT_BODY },
  ...BROADCAST_TEMPLATES.map((t) => ({ label: `broadcast:${t.id}`, text: t.text })),
  { label: "DORMANT_REENGAGEMENT_MESSAGE", text: DORMANT_REENGAGEMENT_MESSAGE },
];

/**
 * 休眠一通（ブロック3-B）の体験原則ガード:
 *   - 本文絵文字禁止（emoji を含まない）。
 *   - 100文字目安（長すぎない・120字以内で運用余白を確保）。
 *   - 押し売り/クーポン/緊急性の演出語を含まない。
 *   - 正本ブランド識別（elxea／エルクシア）を含む。
 */
it("休眠一通: 絵文字を含まない（本文絵文字禁止）", () => {
  // 絵文字（記号・絵文字・補助記号ブロック + 異体字セレクタ + ZWJ）を検出。
  const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u;
  assert(!emojiRe.test(DORMANT_REENGAGEMENT_MESSAGE), "本文に絵文字が含まれている");
});

it("休眠一通: 100文字目安（120字以内）", () => {
  const len = [...DORMANT_REENGAGEMENT_MESSAGE].length;
  assert(len <= 120, `本文が長すぎる（${len}字・目安100・上限120）`);
  assert(len >= 20, `本文が短すぎる（${len}字）`);
});

it("休眠一通: 押し売り/クーポン/緊急性の演出語を含まない", () => {
  const PUSHY = ["クーポン", "セール", "割引", "今だけ", "限定", "お急ぎ", "残りわずか", "特別価格", "％OFF", "%OFF", "OFF"];
  for (const w of PUSHY) {
    assert(!DORMANT_REENGAGEMENT_MESSAGE.includes(w), `本文に演出語「${w}」が含まれている`);
  }
});

it("休眠一通: 正本ブランド識別（elxea／エルクシア）を含む", () => {
  assert(DORMANT_REENGAGEMENT_MESSAGE.includes("elxea"), "elxea");
  assert(DORMANT_REENGAGEMENT_MESSAGE.includes("エルクシア"), "エルクシア");
});

/** 禁止語（非正本・監査確定）。 */
const FORBIDDEN = ["エルシア", "鹿児島を中心", "スキンケア", "合同会社", "静かな豊かさ"];

for (const term of FORBIDDEN) {
  it(`禁止語「${term}」がユーザー向け文字列に現れない`, () => {
    for (const { label, text } of USER_FACING) {
      assert(!text.includes(term), `${label} に禁止語「${term}」が含まれている`);
    }
  });
}

it("正本値: 読み仮名エルクシア / 株式会社elxea が system-prompt に入っている", () => {
  assert(BRAND_NAME_READING === "エルクシア", "reading");
  assert(COMPANY_NAME === "株式会社elxea", "company");
  assert(SYSTEM_PROMPT.includes("エルクシア"), "system-prompt に エルクシア");
  assert(SYSTEM_PROMPT.includes("株式会社elxea"), "system-prompt に 株式会社elxea");
  assert(SYSTEM_PROMPT.includes(SUPPORT_EMAIL), "system-prompt に 正本メール");
});

it("正本値: ⑤about・ウェルカムがブランドステートメント（日本各地の小規模茶農家）に沿う", () => {
  assert(ABOUT_BLURB.includes("日本各地"), "about 日本各地");
  assert(ABOUT_BLURB.includes("シングルオリジン"), "about シングルオリジン");
  assert(WELCOME_INTRO.includes("エルクシア"), "welcome 読み仮名");
  assert(BRAND_STATEMENT_SHORT.includes("小規模茶農家"), "statement 小規模茶農家");
});

it("タグラインは About elxea の正本と一致", () => {
  assert(BRAND_TAGLINE === "日常の中にきらめきを感じられる一杯をあなたにも。", "tagline 正本一致");
});

for (const t of queue) {
  total++;
  try {
    t.fn();
    passed++;
    console.log(`  [PASS] ${t.name}`);
  } catch (err) {
    console.log(`  [FAIL] ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log("\n============================================================");
console.log("brand-copy Test Results");
console.log("============================================================");
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
if (passed < total) process.exit(1);
