/**
 * Unit Tests -- 転送口 /go/store（D4: LINE 仮メニュー ③ の押下を Workers Analytics Engine に記録して 302）
 *
 * 設計: 実装設計 rev2 第7章「D4 転送口 /go/store と記録」/ 第9章 テスト7
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 * 設計 QA（3 回目の軽微 m5: クエリは無視して固定先へ / 外のブラウザで開くと区分はほぼ other）
 *   https://app.notion.com/p/3e770c9d064c81cca15dcec451445605
 *
 * 固定すること（テスト7）:
 *   - GET で writeDataPoint を 1 回だけ呼ぶ（index `go_store`・区分つき）/ 302 で行き先は PURCHASE_URL
 *   - HEAD は 302 で記録しない / GET・HEAD 以外は 405（記録しない）
 *   - 記録先が無い・writeDataPoint が例外を投げても 302
 *   - クエリで行き先が変わらない（開いた転送口にしない）
 *   - bot の User-Agent でも記録し、区分が `bot` になる / User-Agent そのものは記録しない
 * 追加で固定すること:
 *   - 本物の Worker（src/index.ts）経由でも同じ（HEAD を Hono が GET に回しても記録しない /
 *     Firestore 未設定で他の口が 503 のときも /go/store は 302）
 *   - wrangler.toml に本番と staging で別々の記録先がある
 *
 * 使用方法: npx tsx tests/unit/go-store.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import {
  GO_STORE_PATH,
  GO_STORE_INDEX,
  GO_STORE_EVENT,
  classifyUserAgent,
  handleGoStore,
  recordStoreTap,
} from "../../src/routes/go-store";
import { PURCHASE_URL, AMAZON_STORE_URL, EC_SITE_OPEN, isClosedSiteLink } from "../../src/lib/storefront";

// ---------------------------------------------------------------------------
// テストハーネス（外部依存なし・既存 tests/unit/*.test.ts と同じ流儀）
// ---------------------------------------------------------------------------

let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function describe(suiteName: string, fn: () => void) {
  queue.push({ name: `--- ${suiteName} ---`, fn: () => {} });
  fn();
}
function it(testName: string, fn: () => void | Promise<void>) {
  queue.push({ name: testName, fn });
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertTrue(value: boolean, label = "") {
  if (!value) throw new Error(`${label ? label + ": " : ""}expected true`);
}

// ---------------------------------------------------------------------------
// 偽の記録先（AnalyticsEngineDataset の差し替え）
// ---------------------------------------------------------------------------

type FakeDataset = AnalyticsEngineDataset & { calls: AnalyticsEngineDataPoint[] };

function fakeDataset(opts: { throws?: boolean } = {}): FakeDataset {
  const calls: AnalyticsEngineDataPoint[] = [];
  return {
    calls,
    writeDataPoint(point?: AnalyticsEngineDataPoint) {
      calls.push(point ?? {});
      if (opts.throws) throw new Error("simulated writeDataPoint failure");
    },
  };
}

const BASE = "https://elxea-agent.example.workers.dev";
const UA_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_LINE_INAPP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.10.0";
const UA_GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const UA_LINE_PREVIEW = "facebookexternalhit/1.1;line-poker/1.0";

function req(method: string, opts: { path?: string; ua?: string | null } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.ua !== null) headers["User-Agent"] = opts.ua ?? UA_SAFARI;
  return new Request(`${BASE}${opts.path ?? GO_STORE_PATH}`, { method, headers });
}

function assertRedirectToStore(res: Response, label: string) {
  assertEqual(res.status, 302, `${label} status`);
  assertEqual(res.headers.get("Location"), PURCHASE_URL, `${label} Location`);
  assertEqual(res.headers.get("Cache-Control"), "no-store", `${label} Cache-Control`);
}

/** 本物の Worker を呼ぶ（Firestore 未設定の env = 他の口は起動ゲートで 503 になる状態）。 */
const fakeCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;
async function callWorker(request: Request, env: Partial<Env>): Promise<Response> {
  return worker.fetch(request, env as Env, fakeCtx);
}

// ---------------------------------------------------------------------------
// 行き先
// ---------------------------------------------------------------------------

describe("行き先（PURCHASE_URL に固定・閉じたリンクではない）", () => {
  it("閉店中の行き先は Amazon の elxea ストア（PURCHASE_URL）", () => {
    assertEqual(EC_SITE_OPEN, false, "EC_SITE_OPEN（閉店中）");
    assertEqual(PURCHASE_URL, AMAZON_STORE_URL, "PURCHASE_URL");
    assertEqual(isClosedSiteLink(PURCHASE_URL), false, "行き先は閉じたリンクではない");
  });

  it("GET は 302 で PURCHASE_URL へ（本文なし・キャッシュさせない）", async () => {
    const res = handleGoStore(req("GET"), { STORE_TAP_EVENTS: fakeDataset() });
    assertRedirectToStore(res, "GET");
    assertEqual(res.body, null, "本文なし");
  });

  it("クエリ・似たパスで行き先が変わらない（開いた転送口にしない）", () => {
    const queries = [
      "?url=https://evil.example.com",
      "?to=https%3A%2F%2Felxea.com%2Fja",
      "?redirect=//evil.example.com&next=/x",
      "?openExternalBrowser=1",
      "?Location=https://evil.example.com#frag",
    ];
    for (const q of queries) {
      const ds = fakeDataset();
      const res = handleGoStore(req("GET", { path: `${GO_STORE_PATH}${q}` }), { STORE_TAP_EVENTS: ds });
      assertRedirectToStore(res, `query ${q}`);
      assertEqual(ds.calls.length, 1, `query ${q} の記録件数`);
    }
  });
});

// ---------------------------------------------------------------------------
// 記録
// ---------------------------------------------------------------------------

describe("記録（GET で 1 回だけ・区分つき・User-Agent そのものは残さない）", () => {
  it("GET で writeDataPoint を 1 回だけ呼ぶ（index go_store / blobs [tap, 区分] / doubles [1]）", () => {
    const ds = fakeDataset();
    handleGoStore(req("GET", { ua: UA_SAFARI }), { STORE_TAP_EVENTS: ds });
    assertEqual(ds.calls.length, 1, "呼び出し回数");
    const p = ds.calls[0];
    assertEqual(JSON.stringify(p.indexes), JSON.stringify([GO_STORE_INDEX]), "indexes");
    assertEqual(GO_STORE_INDEX, "go_store", "index の値");
    assertEqual(JSON.stringify(p.blobs), JSON.stringify([GO_STORE_EVENT, "other"]), "blobs");
    assertEqual(JSON.stringify(p.doubles), JSON.stringify([1]), "doubles");
  });

  it("User-Agent そのもの・URL は記録しない（blobs は種類と区分の 2 つだけ）", () => {
    const ds = fakeDataset();
    handleGoStore(req("GET", { path: `${GO_STORE_PATH}?utm=secret`, ua: UA_LINE_INAPP }), {
      STORE_TAP_EVENTS: ds,
    });
    const blobs = (ds.calls[0].blobs ?? []).map(String);
    assertEqual(blobs.length, 2, "blobs の数");
    for (const b of blobs) {
      assertTrue(!b.includes("Mozilla") && !b.includes("utm") && !b.includes("http"), `blob に生値なし: ${b}`);
    }
  });

  it("bot の User-Agent でも落とさず記録し、区分は bot", () => {
    for (const ua of [UA_GOOGLEBOT, UA_LINE_PREVIEW, "curl/8.4.0"]) {
      const ds = fakeDataset();
      const res = handleGoStore(req("GET", { ua }), { STORE_TAP_EVENTS: ds });
      assertRedirectToStore(res, `bot ${ua}`);
      assertEqual(ds.calls.length, 1, `bot ${ua} の記録件数`);
      assertEqual(String(ds.calls[0].blobs?.[1]), "bot", `bot ${ua} の区分`);
    }
  });

  it("User-Agent の 3 区分（LINE 内ブラウザ / 外のブラウザ / bot・UA なし）", () => {
    assertEqual(classifyUserAgent(UA_LINE_INAPP), "line_inapp", "LINE 内ブラウザ");
    assertEqual(classifyUserAgent(UA_SAFARI), "other", "外のブラウザ（openExternalBrowser=1 の通常経路）");
    assertEqual(
      classifyUserAgent(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
      ),
      "other",
      "Android Chrome",
    );
    assertEqual(classifyUserAgent(UA_GOOGLEBOT), "bot", "Googlebot");
    assertEqual(classifyUserAgent(UA_LINE_PREVIEW), "bot", "LINE のリンク下見（LINE の文字を含んでも bot）");
    assertEqual(classifyUserAgent(""), "bot", "空");
    assertEqual(classifyUserAgent(null), "bot", "なし");
  });

  it("User-Agent ヘッダが無い GET も記録し（区分 bot）、302", () => {
    const ds = fakeDataset();
    const res = handleGoStore(req("GET", { ua: null }), { STORE_TAP_EVENTS: ds });
    assertRedirectToStore(res, "UA なし");
    assertEqual(String(ds.calls[0].blobs?.[1]), "bot", "区分");
  });
});

// ---------------------------------------------------------------------------
// 記録に失敗しても転送は必ず成功する
// ---------------------------------------------------------------------------

describe("記録の失敗は転送を止めない", () => {
  it("記録先が無い（未束縛）でも 302", () => {
    const res = handleGoStore(req("GET"), {});
    assertRedirectToStore(res, "未束縛");
    assertEqual(recordStoreTap(undefined, "other"), false, "recordStoreTap は false");
  });

  it("writeDataPoint が例外を投げても 302（例外は外に出ない）", () => {
    const ds = fakeDataset({ throws: true });
    const res = handleGoStore(req("GET"), { STORE_TAP_EVENTS: ds });
    assertRedirectToStore(res, "例外");
    assertEqual(ds.calls.length, 1, "呼んではいる");
    assertEqual(recordStoreTap(fakeDataset({ throws: true }), "other"), false, "recordStoreTap は false");
  });
});

// ---------------------------------------------------------------------------
// メソッド
// ---------------------------------------------------------------------------

describe("メソッド（HEAD は記録しない / GET・HEAD 以外は 405）", () => {
  it("HEAD は 302 で記録しない", () => {
    const ds = fakeDataset();
    const res = handleGoStore(req("HEAD"), { STORE_TAP_EVENTS: ds });
    assertRedirectToStore(res, "HEAD");
    assertEqual(ds.calls.length, 0, "記録しない");
  });

  it("GET・HEAD 以外は 405（Allow: GET, HEAD）で記録しない", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const ds = fakeDataset();
      const res = handleGoStore(req(m), { STORE_TAP_EVENTS: ds });
      assertEqual(res.status, 405, `${m} status`);
      assertEqual(res.headers.get("Allow"), "GET, HEAD", `${m} Allow`);
      assertEqual(res.headers.get("Location"), null, `${m} Location なし`);
      assertEqual(ds.calls.length, 0, `${m} 記録しない`);
    }
  });
});

// ---------------------------------------------------------------------------
// 本物の Worker（src/index.ts）経由
// ---------------------------------------------------------------------------

describe("本物の Worker 経由（ルート登録・Firestore 起動ゲートの除外）", () => {
  it("前提: Firestore 未設定の env では他の口は起動ゲートで 503（このテストの env が意味を持つことの確認）", async () => {
    const res = await callWorker(new Request(`${BASE}/api/alerts/status`), {});
    assertEqual(res.status, 503, "他の口は 503");
  });

  it("Firestore 未設定でも GET /go/store は 302 で 1 件記録", async () => {
    const ds = fakeDataset();
    const res = await callWorker(req("GET", { path: `${GO_STORE_PATH}?to=https://evil.example.com` }), {
      STORE_TAP_EVENTS: ds,
    });
    assertRedirectToStore(res, "worker GET");
    assertEqual(ds.calls.length, 1, "記録件数");
  });

  it("HEAD（Hono が GET のルートへ回す）でも記録しない", async () => {
    const ds = fakeDataset();
    const res = await callWorker(req("HEAD"), { STORE_TAP_EVENTS: ds });
    assertRedirectToStore(res, "worker HEAD");
    assertEqual(ds.calls.length, 0, "記録しない");
  });

  it("POST は 405 で記録しない", async () => {
    const ds = fakeDataset();
    const res = await callWorker(req("POST"), { STORE_TAP_EVENTS: ds });
    assertEqual(res.status, 405, "status");
    assertEqual(ds.calls.length, 0, "記録しない");
  });

  it("記録先が未束縛の Worker でも 302", async () => {
    const res = await callWorker(req("GET"), {});
    assertRedirectToStore(res, "worker 未束縛");
  });
});

// ---------------------------------------------------------------------------
// wrangler.toml（本番と staging で別々の記録先）
// ---------------------------------------------------------------------------

/** 指定ヘッダ（例: `[[analytics_engine_datasets]]`）の直下の key = "value" を読む（コメント行は無視）。 */
function readTomlBlocks(toml: string, header: string): Array<Record<string, string>> {
  const blocks: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;
    if (line.startsWith("[")) {
      current = line === header ? {} : null;
      if (current) blocks.push(current);
      continue;
    }
    const m = /^([A-Za-z_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (current && m) current[m[1]] = m[2];
  }
  return blocks;
}

describe("wrangler.toml（記録先は本番と staging で別々）", () => {
  const toml = readFileSync(join(process.cwd(), "wrangler.toml"), "utf8");
  const prod = readTomlBlocks(toml, "[[analytics_engine_datasets]]");
  const staging = readTomlBlocks(toml, "[[env.staging.analytics_engine_datasets]]");

  it("本番: binding STORE_TAP_EVENTS → dataset elxea_store_taps（1 件だけ）", () => {
    assertEqual(prod.length, 1, "本番の記録先の数");
    assertEqual(prod[0].binding, "STORE_TAP_EVENTS", "binding");
    assertEqual(prod[0].dataset, "elxea_store_taps", "dataset");
  });

  it("staging: binding STORE_TAP_EVENTS → dataset elxea_store_taps_staging（1 件だけ）", () => {
    assertEqual(staging.length, 1, "staging の記録先の数");
    assertEqual(staging[0].binding, "STORE_TAP_EVENTS", "binding");
    assertEqual(staging[0].dataset, "elxea_store_taps_staging", "dataset");
  });

  it("本番と staging の dataset は別名（テスト OA の押下が本番の回数に混ざらない）", () => {
    assertTrue(prod[0].dataset !== staging[0].dataset, "dataset が別");
  });
});

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

(async () => {
  console.log("\n=== go-store (D4) Unit Tests ===\n");
  for (const t of queue) {
    if (t.name.startsWith("---")) {
      console.log(`\n${t.name}`);
      continue;
    }
    try {
      await t.fn();
      passedTests++;
      console.log(`  [OK] ${t.name}`);
    } catch (err) {
      failedTests++;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ name: t.name, error: msg });
      console.log(`  [FAIL] ${t.name}\n         ${msg}`);
    }
  }
  console.log(`\n--- Result: ${passedTests} passed, ${failedTests} failed ---\n`);
  if (failedTests > 0) {
    for (const f of failures) console.log(`FAIL: ${f.name} -- ${f.error}`);
    process.exit(1);
  }
})();
