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

/**
 * テストとテストの **あいだ** に敷く fetch（永久に決まらない Promise を返す）。
 *
 * ─ なぜ要るか ─
 *   このリポジトリの記録系は fire-and-forget で、呼び出し側は応答を待たない
 *   （`logFlowEvent` / `recordBehaviorEvent` は `void` で投げっぱなし）。
 *   投げっぱなしということは、**テストが終わったあとも走り続ける尻尾がある**
 *   ということでもある。afterEach で実 fetch を戻すと、その尻尾が
 *   モックではなく実ネットワークへ出る。
 *
 *   実際に CI で出た（2026-08-28 / CDP Stage 1）: 記録 1 件あたりの往復が
 *   1 回から 3 回に増えた結果、尻尾がテストの寿命を超えるようになり
 *   `DNS lookup failed; host = mock-supabase.e2e.local` に到達した。
 *   さらにその失敗を尻尾が console に書こうとして、環境が畳まれた後の
 *   ログ送信になり `EnvironmentTeardownError` の未処理拒否が 2 件出た。
 *   **テストは 114 件すべて緑なのに CI だけが赤**という、いちばん読みにくい形。
 *
 * ─ なぜ「throw」でも「エラー応答」でもなく「決まらない」なのか ─
 *   throw すれば未処理拒否がまた出る。エラー応答を返せば呼び出し側が
 *   console に書き、環境が畳まれた後のログ送信でまた落ちる。
 *   尻尾に対して唯一安全なのは **何も起こさないこと** で、決まらない Promise は
 *   それを表現できる唯一の形。テストプロセスが終われば一緒に消える。
 *
 * ─ 何が強くなるか ─
 *   これは緩和ではなく **強化** である。従来は afterEach と次の beforeEach の
 *   あいだに実ネットワークへ出られる窓が空いていた（ハーメティックの穴）。
 *   その窓を閉じる。
 */
const BETWEEN_TESTS_FETCH = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

afterEach(() => {
  guard?.restore();
  guard = undefined;
  globalThis.fetch = BETWEEN_TESTS_FETCH;
});
