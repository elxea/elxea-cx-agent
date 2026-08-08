/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * ハーメティックテストの `import { env } from "cloudflare:test"` に、vitest.config.ts の
 * bindings 型を与える（ProvidedEnv 拡張）。値の SoT は vitest.config.ts の miniflare.bindings。
 */
declare module "cloudflare:test" {
  interface ProvidedEnv {
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    LINE_CHANNEL_SECRET: string;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    LINE_CHANNEL_ACCESS_TOKEN_TEST: string;
    DELIVERY_TARGET_ENV: string;
    LIFF_LINKAGE_URL: string;
    NOTION_TOKEN: string;
    NOTION_TEA_MENU_DB_ID: string;
    NOTION_PRODUCT_LIST_DB_ID: string;
    NOTION_SET_MENU_DB_ID: string;
    ANTHROPIC_API_KEY: string;
    /** roji 最初のアンケートの停止スイッチ。テストでは "true"（ON）。flow17 が一時的に上書きする。 */
    ROJI_SURVEY_ENABLED?: string;
  }
}
