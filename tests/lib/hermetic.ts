/**
 * ハーメティックなネットワーク境界（設計 §2-5「安全は機械で固定」）。
 *
 * installHermeticFetch は isolate 全体の globalThis.fetch を差し替え、全 outbound を:
 *   1. assertNotProdUrl で本番接触を fail-closed 検査（assert-not-prod の強制 import 点）、
 *   2. LINE / Notion / Supabase の各モックへルーティング、
 *   3. それ以外（Firestore googleapis 等・本フローでは fire-and-forget）は throw（fail-closed）。
 * install 時に assertNotProdEnv で env も検査する（本番 ref/OA/送信フラグを二重ガード）。
 *
 * これにより「本モジュール（＝assert-not-prod）を通さずに実ネットワークへ出る」ことが構造的に不可能になる。
 * ハーメティック＝実ネットワーク不使用・staging/本番いずれにも接続しない・実送信ゼロ。
 */

import { assertNotProdEnv, assertNotProdUrl } from "./assert-not-prod";
import { createLineCapture, type LineCapture } from "./mock-line";
import { createSupabaseMock, type SupabaseMock } from "./mock-supabase";
import { createNotionTeaMock, type NotionTeaMock } from "./tea-fixtures";

export interface Hermetic {
  line: LineCapture;
  supabase: SupabaseMock;
  notion: NotionTeaMock;
  /** globalThis.fetch を元に戻す（afterEach で呼ぶ）。 */
  restore(): void;
}

/**
 * 差し替え済み fetch に付ける識別マーカー（idempotent 判定用）。
 * グローバル setup（tests/lib/hermetic-setup.ts）と各テストの beforeEach が
 * 二重に install しても、2 回目以降は既存インスタンスを返して二重ラップを避ける。
 */
const HERMETIC_MARK = "__elxeaHermeticFetch__";

/** 現在この isolate で有効なハーメティックインスタンス（未 install なら null）。 */
let active: Hermetic | null = null;

/** この isolate で既にハーメティック fetch が敷かれているか。 */
export function isHermeticInstalled(): boolean {
  return active !== null && (globalThis.fetch as unknown as Record<string, unknown>)[HERMETIC_MARK] === true;
}

/**
 * 現在有効なハーメティックインスタンスを返す。
 * グローバル setup が全ハーメティックファイルの beforeEach で install するため、
 * テストは installHermeticFetch を自分で呼ばずに本アクセサで line/supabase/notion を取れる。
 * 未 install で呼ぶと throw（＝ガードが敷かれていないことを早期に検出する）。
 */
export function getHermetic(): Hermetic {
  if (!isHermeticInstalled() || active === null) {
    throw new Error(
      "[hermetic] ガード未設置で getHermetic() が呼ばれた。vitest setupFiles（tests/lib/hermetic-setup.ts）が有効か確認する。",
    );
  }
  return active;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/**
 * ハーメティック fetch を isolate に敷く。
 * @param env cloudflare:test の env（bindings）。install 時に本番でないことを検査する。
 */
export function installHermeticFetch(env: Record<string, unknown>): Hermetic {
  // assert-not-prod の強制点（install するたびに env を fail-closed 検査）。
  assertNotProdEnv(env);

  // Idempotent: 既にこの isolate で敷かれているなら二重ラップせず既存インスタンスを返す。
  //   グローバル setup が beforeEach で install した後、各テスト（旧来の per-file 呼び出し）が
  //   重ねて呼んでも安全にする。復元は一度で完結し、original（実 fetch）を確実に取り戻す。
  if (isHermeticInstalled() && active !== null) {
    return active;
  }

  const supabaseHost = new URL(String(env.SUPABASE_URL)).host;
  const line = createLineCapture();
  const supabase = createSupabaseMock();
  const notion = createNotionTeaMock();

  const original = globalThis.fetch;

  const router = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    // 全 outbound で本番接触を検査（fail-closed）。
    assertNotProdUrl(url);

    // Request オブジェクトで渡された場合に備えて method/body/headers を拾う（本番コードは string+init で呼ぶ）。
    const reqInit: RequestInit =
      init ??
      (input instanceof Request
        ? {
            method: input.method,
            headers: input.headers,
            body: await input.clone().text().catch(() => undefined),
          }
        : {});

    if (url.includes("api.line.me") || url.includes("api-data.line.me")) {
      return line.handle(url, reqInit);
    }
    if (url.includes("api.notion.com")) {
      return notion.handle(url, reqInit);
    }
    if (url.includes(supabaseHost)) {
      return supabase.handle(url, reqInit);
    }
    // それ以外は実ネットワーク＝ハーメティック違反。fail-closed で止める
    // （Firestore 等の fire-and-forget 呼び出しは呼び出し側の .catch が握るため会話は止まらない）。
    throw new Error(`[hermetic] 非モックの外部ネットワークをブロック: ${url}`);
  }) as typeof fetch;

  // idempotent 判定用のマーカーを差し替え後の fetch に付ける。
  (router as unknown as Record<string, unknown>)[HERMETIC_MARK] = true;
  globalThis.fetch = router;

  const instance: Hermetic = {
    line,
    supabase,
    notion,
    restore() {
      globalThis.fetch = original;
      active = null;
    },
  };
  active = instance;
  return instance;
}
