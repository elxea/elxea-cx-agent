/**
 * 署名付き LINE webhook を Worker へインプロセス dispatch するヘルパ（設計 §2-2）。
 *
 * unit スタイル: import した Worker default（= vitest.config.ts の main と同一インスタンス）を
 *   worker.fetch(request, env, ctx) で直接叩く。ctx は createExecutionContext() で作り、
 *   dispatch 後に waitOnExecutionContext(ctx) で waitUntil(processEvents) の完了を待つ。
 *   → lineWebhook は即 200 を返し実処理を waitUntil に載せるため、返答（LINE 送信モック）を
 *     捕捉するには waitUntil の完了待ちが必須。
 *
 * 署名は本番と同一の HMAC-SHA256(body, LINE_CHANNEL_SECRET) を base64 で付ける
 *   （src/lib/line.ts verifyLineSignature を実際に通す）。
 */

import worker from "../../src/index";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../../src/index";

/** HMAC-SHA256(body) を base64 で返す（Web Crypto・workerd 互換）。 */
async function hmacSha256Base64(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export interface DispatchResult {
  status: number;
}

/**
 * 署名付き webhook を Worker の /webhook/line に dispatch し、waitUntil 完了まで待つ。
 * @param env cloudflare:test の env（bindings）。
 * @param channelSecret 署名に使う LINE_CHANNEL_SECRET（env と一致させる）。
 * @param events LINE イベント配列（synthetic.messageEvent などで組む）。
 */
export async function dispatchLineWebhook(opts: {
  env: unknown;
  channelSecret: string;
  events: Array<Record<string, unknown>>;
}): Promise<DispatchResult> {
  const body = JSON.stringify({
    destination: "U" + "0".repeat(32),
    events: opts.events,
  });
  const signature = await hmacSha256Base64(opts.channelSecret, body);

  const request = new Request("https://elxea-agent.e2e.local/webhook/line", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-line-signature": signature,
    },
    body,
  });

  const ctx = createExecutionContext();
  const res = await worker.fetch(request, opts.env as Env, ctx);
  // 実処理（processEvents）は waitUntil に載るため、完了を待ってから返答を assert する。
  await waitOnExecutionContext(ctx);
  return { status: res.status };
}

/**
 * 保留中の非同期（fire-and-forget の void 記録など）を落ち着かせる。
 *
 * tea-menu.ts の product_ratings 書込は `void recordProductRating(...)` の fire-and-forget で、
 * 実行コンテキストに waitUntil 登録されない。本ハーメティック環境ではモック fetch が純 JS の
 * promise チェーンなので、microtask を数十回フラッシュすれば確実に落ち着く（実ネットワーク不要）。
 * DB 効果（モック Supabase の行）を assert する前に呼ぶ。
 */
export async function settle(rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}
