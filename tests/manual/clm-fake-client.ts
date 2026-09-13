/**
 * 偽の OpenAI クライアント — CLM 受け口(/v1/chat/completions)を Hume 抜きで叩く
 *
 * Hume の残枠を 1 秒も使わずに「SSE の形」「本当に流れているか」「鍵なしで拒否されるか」を
 * 目で見るための手動スクリプト。会話本体は偽物に差し替えてあるので、Anthropic にも
 * Supabase にも Workers AI にも触らない。自動判定は tests/unit/clm-shim.test.ts が持つ。
 *
 * 使用方法:
 *   npx tsx tests/manual/clm-fake-client.ts
 *
 * 読み方: 各行頭の [+NNNms] が「そのフレームが届いた時刻」。全文待ちなら最後にまとめて
 * 出るが、実際には delta ごとに時刻がずれて出る（= ストリーミングが成立している）。
 */
import { Hono } from "hono";
import { createClmChatCompletionsHandler } from "../../src/routes/clm";
const fake: any = async (_m: any, _h: any, _e: any, _u: any, _c: any, _env: any, cb: any) => {
  for (const d of ["こんにちは", "。roji の", "案内係です。"]) { cb.onTextDelta(d); await new Promise(r => setTimeout(r, 40)); }
  cb.onDone("こんにちは。roji の案内係です。");
  return { escalated: false, flexMessages: [], productCards: [], quickReplies: [] };
};
const app = new Hono();
(async () => {
app.post("/v1/chat/completions", createClmChatCompletionsHandler({ runAgentStreaming: fake, createEmbedding: async () => new Array(4).fill(0) }));
const env: any = { CLM_API_SECRET: "demo-secret" };
const mk = (h: Record<string,string>) => new Request("http://x/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify({ model: "elxea-cx-agent", stream: true, messages: [{ role: "system", content: "Hume側の最小prompt" }, { role: "user", content: "煎茶の淹れ方を教えて", models: { prosody: { scores: { joy: 0.42 } } } }], custom_session_id: "hume-session-abc" }) });
  console.log("\n### 1) 鍵なし");
const r1 = await app.fetch(mk({}), env); console.log("HTTP", r1.status, await r1.text());
  console.log("\n### 2) 鍵あり — 生の SSE バイト列");
const r2 = await app.fetch(mk({ "X-API-Key": "demo-secret" }), env);
  console.log("HTTP", r2.status, "Content-Type:", r2.headers.get("Content-Type"));
const rd = (r2.body as any).getReader(); const dec = new TextDecoder(); const t0 = Date.now();
for (;;) { const { done, value } = await rd.read(); if (done) break; process.stdout.write(`[+${String(Date.now()-t0).padStart(4)}ms] ${dec.decode(value)}`); }

})();
