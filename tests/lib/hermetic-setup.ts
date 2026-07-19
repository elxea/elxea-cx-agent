/**
 * グローバル・ハーメティックガード（vitest setupFiles・設計 §2-5「安全は機械で固定」の全体化）。
 *
 * vitest.config.ts の test.setupFiles にこのファイルを登録することで、tests/hermetic/** の
 * すべてのテストファイルに対して beforeEach で installHermeticFetch(env) が自動で走る。
 *   → 各ファイルが installHermeticFetch を呼び忘れても、実ネットワークへ出ることが構造的に不可能になる
 *     （globalThis.fetch は fail-closed ルータに差し替わり、非モックの外部接触は throw する）。
 *
 * これが QA caveat（「強制が per-file 規約であり、将来ファイルが呼び忘れると素の fetch で走る」）の解消点。
 * 既存の per-file 呼び出しは installHermeticFetch の idempotent 化により無害（同一インスタンスを返す）。
 *
 * 注記: このモジュールは workerd（Miniflare）プール内で実行され、`cloudflare:test` の env
 *   （vitest.config.ts の miniflare.bindings＝すべてモック値）にアクセスできる。
 */

import { afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "./hermetic";

let guard: Hermetic | undefined;

// setupFiles の beforeEach は、テストファイル側の root-level beforeEach より先に登録・実行される。
// ゆえに各テスト本体が走る時点では必ずガードが敷かれている（呼び忘れ不能）。
beforeEach(() => {
  guard = installHermeticFetch(env as unknown as Record<string, unknown>);
});

afterEach(() => {
  guard?.restore();
  guard = undefined;
});
