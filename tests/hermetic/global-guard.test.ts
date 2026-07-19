/**
 * ハーメティック L1 — グローバルガードのロードベアリング証明。
 *
 * このファイルは意図的に installHermeticFetch を **呼ばない**（＝将来「呼び忘れた」ファイルの再現）。
 * それでも vitest setupFiles（tests/lib/hermetic-setup.ts）が beforeEach でガードを敷くため、
 *   - 素の外部 fetch（example.com）は fail-closed で throw され、
 *   - 本番マーカー付き URL は assert-not-prod により ProdContactError で拒否される。
 *
 * ここが緑である限り「per-file の install 呼び忘れでも実ネットワークに出られない」ことが保証される。
 * これが QA caveat（強制が per-file 規約に留まる）の解消を裏づけるテスト。
 */

import { describe, expect, it } from "vitest";
import { getHermetic, isHermeticInstalled } from "../lib/hermetic";
import { PROD_SUPABASE_REF, ProdContactError } from "../lib/assert-not-prod";

describe("hermetic L1 — グローバルガード（install 呼び忘れでも保護される）", () => {
  it("install を呼ばなくても isHermeticInstalled()＝true（setupFiles が敷いている）", () => {
    expect(isHermeticInstalled()).toBe(true);
    // アクセサ経由でモック群に到達できる（ガードが実体を持って敷かれている証拠）。
    const h = getHermetic();
    expect(h.line).toBeDefined();
    expect(h.supabase).toBeDefined();
    expect(h.notion).toBeDefined();
  });

  it("stray な外部 fetch(example.com) は fail-closed で拒否される", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(
      /非モックの外部ネットワークをブロック/,
    );
  });

  it("本番マーカー付き URL は ProdContactError で拒否される（assert-not-prod がグローバルに効く）", async () => {
    const prodUrl = `https://${PROD_SUPABASE_REF}.supabase.co/rest/v1/x`;
    await expect(fetch(prodUrl)).rejects.toBeInstanceOf(ProdContactError);
  });
});
