import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * ハーメティック L1 バックエンド動線 E2E（設計 §2-6・§3 Phase 1）。
 *
 * Worker を workerd（Miniflare）内にインプロセス起動し、デプロイ不要でローカル完結する。
 * bindings は「staging 相当のモック値」を **インライン注入** する（実 wrangler.toml は読まない）。
 *   → wrangler.toml の [vars]（DELIVERY_TARGET_ENV="prod" 等）を持ち込まないための意図的な分離。
 *   本番 ref/OA/トークンは決して置かない（tests/lib/assert-not-prod が install 時に再検査＝二重ガード）。
 *
 * 版 pin（設計 §4-6）: @cloudflare/vitest-pool-workers@0.18.6 / vitest@4.1.10。
 *   外部 fetch モックは版差のある cloudflare:test の fetchMock ではなく、
 *   globalThis.fetch の差し替え（tests/lib/hermetic.ts）で行う（版非依存・返答捕捉が容易）。
 */
export default defineConfig({
  test: {
    include: ["tests/hermetic/**/*.test.ts"],
    // グローバル・ハーメティックガード（§2-5 の全体化）。全ハーメティックファイルの beforeEach で
    // installHermeticFetch(env) を自動実行し、個々のファイルが呼び忘れても実ネットワークへ出られない
    // ようにする（QA caveat「per-file 規約依存」の解消）。詳細は tests/lib/hermetic-setup.ts。
    setupFiles: ["./tests/lib/hermetic-setup.ts"],
    // ハーメティック（ネットワーク不使用）だが、万一の遅延に備えて余裕を持たせる。
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  plugins: [
    cloudflareTest({
      // import worker from "../../src/index" が、この main と同一インスタンスを返す。
      main: "./src/index.ts",
      miniflare: {
        // 本番 wrangler.toml と同じ互換設定でパリティを取る（挙動不変）。
        compatibilityDate: "2025-03-07",
        compatibilityFlags: ["nodejs_compat"],
        // すべて「モック値」。実在の本番トークン・prod Supabase ref・prod OA は絶対に置かない。
        bindings: {
          // Database（モック Supabase・§4-1）。host はハーメティック専用の解決不能ドメイン。
          SUPABASE_URL: "https://mock-supabase.e2e.local",
          SUPABASE_SERVICE_ROLE_KEY: "e2e-mock-service-role-key",
          // LINE（送信は必ずモックして捕捉する。api.line.me を実際に叩かない）。
          LINE_CHANNEL_SECRET: "e2e-mock-line-channel-secret",
          LINE_CHANNEL_ACCESS_TOKEN: "e2e-mock-line-access-token",
          LINE_CHANNEL_ACCESS_TOKEN_TEST: "e2e-mock-line-access-token-test",
          // 配信は必ず test 環境固定（本番 OA @307tzhkw へ向けない）。送信フラグは置かない＝dry-run。
          DELIVERY_TARGET_ENV: "test",
          // 連携招待ボタンの遷移先（staging 相当のモック LIFF URL）。
          LIFF_LINKAGE_URL: "https://liff.line.me/e2e-mock-liff",
          // Notion（tea-menu の販売中お茶取得。実際は tests/lib/tea-fixtures がモック応答する）。
          NOTION_TOKEN: "e2e-mock-notion-token",
          NOTION_TEA_MENU_DB_ID: "e2e-mock-tea-menu-db",
          NOTION_PRODUCT_LIST_DB_ID: "e2e-mock-product-db",
          NOTION_SET_MENU_DB_ID: "e2e-mock-set-menu-db",
          // AI（tea/welcome/linkage 動線では未使用だが型充足のためダミー）。
          ANTHROPIC_API_KEY: "e2e-mock-anthropic-key",
          // web-app proxy の共有鍵（モック値）。これが無いと `isTrustedServerCaller` が
          //   常に false になり、**「ログイン済みの人が Web で話す」経路をテストできない**
          //   ＝ 2026-08-30 の本番切断がそのまま素通りする。実鍵は決して置かない
          //   （assert-not-prod の prod マーカー検査も通る無害な文字列）。
          SYNC_API_SECRET: "e2e-mock-sync-api-secret",
          // session_id が「サーバ発行のものか」を確かめる HMAC 鍵（モック値）。
          //   これが無いと署名検証が常に落ち、**他人の session_id を名乗る攻撃を
          //   テストで再現できない**（全部 fail-closed に倒れて緑になってしまう）。
          CHAT_SESSION_SECRET: "e2e-mock-chat-session-secret",
          // roji 最初のアンケートの停止スイッチ。動線17 を検証するため **テストでは ON** にする。
          //   これは送信フラグではない（アンケートは返信のみで LINE 送信系 API を呼ばない）ので
          //   assert-not-prod の assertSendDisabled の対象外。実送信はゼロのまま。
          //   OFF/未設定側の挙動は flow17 の「停止スイッチ」describe が env を一時上書きして検証する。
          ROJI_SURVEY_ENABLED: "true",
          // E6'（Firebase 未設定なら起動拒否）の申告。
          //   ハーメティックは Firebase 資格情報を持たない（実 Firestore を叩かないため
          //   持ってはいけない）。既定のままだと入口ゲートが全リクエストを 503 にして
          //   全動線が落ちるので、「未設定で動かす」を明示的に宣言する。
          //   本番（DELIVERY_TARGET_ENV="prod"）ではこの宣言は無視される仕様なので、
          //   ここに置いても本番の fail-closed は緩まない（上の DELIVERY_TARGET_ENV="test" も参照）。
          //   正本: src/lib/firestore.ts の assertFirestoreConfigured。
          FIRESTORE_UNCONFIGURED_ACK: "true",
        },
      },
    }),
  ],
});
