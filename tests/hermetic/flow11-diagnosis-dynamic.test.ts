/**
 * ハーメティック L1 — 動線6: 好み診断のおすすめが販売中カタログから動的解決される（監査 #6）。
 *
 * 署名付き webhook → Worker インプロセス dispatch → LINE 送信モックで診断結果を捕捉 → 番号を assert。
 *   - 診断結果（各 persona）のおすすめ 5 桁は、すべて販売中カタログ（Notion モック = TEA_FIXTURE）内。
 *   - 旧ハードコード RESULTS の在庫外番号（40601 / 10501 / 50401 等）は一切現れない（break-proof:
 *     旧挙動なら固定 5 桁を出して失敗する）。
 *   - 診断出所つきカードトークン（このお茶｜{番号}｜診断）は保持し、card→感想 チェーンへ接続する。
 *   - カタログ空（取得失敗・在庫ゼロ）は graceful フォールバック（persona 受け止め + 相談導線・死番号なし）。
 *
 * フィクスチャ（tea-fixtures.TEA_FIXTURE = 11301/11401/11501/20101/40101）は旧ハードコードの
 * 大半の番号を意図的に含まない ＝「動的解決していないと必ず番号が外れる」状態で #6 を機械検証する。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { messageEvent, synthLineUserId } from "../lib/synthetic";
import { _resetTeaCache } from "../../src/lib/tea-menu";
import { TEA_FIXTURE } from "../lib/tea-fixtures";
import {
  buildResultWithTeas,
  buildResultFallback,
  diagnosisRecommendationKarte,
} from "../../src/lib/preference-diagnosis";

let h: Hermetic;

beforeEach(() => {
  _resetTeaCache(); // Notion TTL キャッシュを毎テストで初期化（フィクスチャの決定性を担保）。
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

/** 販売中カタログの番号集合（動的解決の許容集合）。 */
const AVAILABLE = new Set(TEA_FIXTURE.map((t) => t.number));

/** 旧ハードコード RESULTS が直書きしていた在庫外番号（現れてはいけない）。 */
const LEGACY_HARDCODED = ["40601", "10501", "10201", "40201", "11601", "50401", "10801"];

type CapturedMsg = {
  text?: unknown;
  quickReply?: { items?: Array<{ action?: { text?: string } }> };
};

/** 捕捉メッセージ（text + quickReply ボタン）から 5 桁番号を全て集める。 */
function allFiveDigits(msgs: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const raw of msgs) {
    const m = raw as CapturedMsg;
    for (const n of String(m.text ?? "").match(/\d{5}/g) ?? []) out.push(n);
    for (const item of m.quickReply?.items ?? []) {
      for (const n of (item.action?.text ?? "").match(/\d{5}/g) ?? []) out.push(n);
    }
  }
  return out;
}

describe("hermetic L1 — 動線6: 診断おすすめの動的解決（監査 #6）", () => {
  const CASES: Array<[string, string]> = [
    ["serenity", "診断｜1｜1｜1"],
    ["explorer", "診断｜2｜2｜2"],
    ["sensory", "診断｜3｜3｜3"],
  ];

  for (const [label, token] of CASES) {
    it(`${label}: おすすめ 5 桁は全て販売中カタログ内・旧ハードコード番号は出ない`, async () => {
      const user = synthLineUserId("f11" + label.slice(0, 1));
      const { status } = await dispatchLineWebhook({
        env,
        channelSecret: String(env.LINE_CHANNEL_SECRET),
        events: [messageEvent(user, token)],
      });
      expect(status).toBe(200);
      await settle();

      const msgs = h.line.allMessages();
      const reply = h.line.texts().join("\n---\n");
      expect(reply.length, "診断結果が返る").toBeGreaterThan(0);
      // persona の受け止めが届く（結果段に到達している）。
      expect(reply).toMatch(/あなたは【/);

      const nums = allFiveDigits(msgs);
      expect(nums.length, "おすすめ番号が 1 件以上").toBeGreaterThan(0);
      for (const n of nums) {
        expect(AVAILABLE.has(n), `${n} は販売中カタログ内（動的解決）`).toBe(true);
      }
      // break-proof: 旧ハードコード（在庫外）番号は一切現れない。
      for (const legacy of LEGACY_HARDCODED) {
        expect(reply.includes(legacy), `旧ハードコード ${legacy} が出ない`).toBe(false);
      }
      // 診断出所つきカードトークンで card→感想 チェーンへ接続（従来どおり）。
      const hasDiagToken = msgs.some((raw) =>
        ((raw as CapturedMsg).quickReply?.items ?? []).some((it) =>
          /^このお茶｜\d{5}｜診断$/.test(it.action?.text ?? ""),
        ),
      );
      expect(hasDiagToken, "診断出所つきカードトークンを保持").toBe(true);
    });
  }

  it("カタログ空 → graceful フォールバック（persona 受け止め + 相談導線・死番号なし）[pure]", () => {
    for (const w of ["serenity", "explorer", "sensory"] as const) {
      const m = buildResultWithTeas(w, [], diagnosisRecommendationKarte(w));
      expect(m.text.match(/\d{5}/g), `${w}: 死番号なし`).toBeNull();
      expect(
        m.quickReplies.some((q) => q.action.text === "お茶選びを相談したいです"),
        `${w}: 相談導線を提示`,
      ).toBe(true);
      expect(m.text).toMatch(/あなたは【/);
    }
    const fb = buildResultFallback("serenity");
    expect(fb.text.match(/\d{5}/g)).toBeNull();
  });
});
