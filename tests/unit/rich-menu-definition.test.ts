/**
 * Unit Tests -- リッチメニューの定義（仮メニュー 3 枠・Amazon）と運転（--list / --set-default / --stateless / basicId 照合）
 *
 * 設計: 実装設計 rev2 第9章 テスト6（rich-menu-definition）・テスト8（setup-rich-menu の照合）
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *   テスト6の「/go/store で終わる」は QA 軽微 m5 に合わせ「パスが /go/store・クエリ付き可」で固定する
 *   （③ は openExternalBrowser=1 を付けて外のブラウザで開く）。
 *
 * LINE API は呼ばない（fetch はすべてモック）。
 *
 * 使用方法: npx tsx tests/unit/rich-menu-definition.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNELS,
  CHAT_BAR_TEXT,
  DEFAULT_RICH_MENU_IMAGE_PATH,
  MENU_NAME,
  RICH_MENU_IMAGE_MAX_BYTES,
  RICH_MENU_SIZE,
  STORE_PATH,
  buildRichMenuBody,
  parseCliArgs,
  readPngSize,
  storeUriFor,
  validateRichMenuImage,
  type ChannelKey,
  type CliOptions,
} from "../../scripts/lib/rich-menu-definition";
import {
  LINE_STATELESS_TOKEN_URL,
  parseDevVars,
  runRichMenuCommand,
  type RunnerDeps,
} from "../../scripts/lib/rich-menu-runner";
import { BREW_RICH_MENU_TRIGGER } from "../../src/lib/menu-tap";
import { DIAGNOSIS_TRIGGER } from "../../src/lib/preference-diagnosis";
import { isClosedSiteLink } from "../../src/lib/storefront";

let total = 0;
let passed = 0;
let failed = 0;
const failures: Array<{ name: string; error: string }> = [];

async function it(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${name}: ${msg}`);
    failures.push({ name, error: msg });
  }
}

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** PNG の見出しだけを持つ偽の画像（大きさと容量を自由に作る）。 */
function fakePng(width: number, height: number, totalBytes = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(totalBytes, 24));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

// ---------------------------------------------------------------------------
// LINE API のモック
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const OLD_6SLOT_ID = "richmenu-4383dd8074a470e13a19bf2463ef8ee3";
const STALE_3SLOT_ID = "richmenu-11111111111111111111111111111111";
const NEW_ID = "richmenu-22222222222222222222222222222222";
const STATELESS_TOKEN = "stateless-token-value-must-not-be-logged";
const CHANNEL_SECRET = "channel-secret-value-must-not-be-logged";

function makeLine(opts: { basicId: string; defaultId?: string | null }) {
  const calls: Call[] = [];
  let currentDefault: string | null = opts.defaultId === undefined ? OLD_6SLOT_ID : opts.defaultId;
  const menus = [
    { richMenuId: OLD_6SLOT_ID, name: "elxea メインメニュー（6 枠 Option A）", size: { width: 2500, height: 1686 }, areas: new Array(6) },
    { richMenuId: STALE_3SLOT_ID, name: MENU_NAME, size: { width: 2500, height: 843 }, areas: new Array(3) },
  ];
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    if (url === LINE_STATELESS_TOKEN_URL && method === "POST") {
      return json({ token_type: "Bearer", access_token: STATELESS_TOKEN, expires_in: 900 });
    }
    if (url.endsWith("/v2/bot/info") && method === "GET") return json({ basicId: opts.basicId, displayName: "x" });
    if (url.endsWith("/v2/bot/user/all/richmenu") && method === "GET") {
      return currentDefault ? json({ richMenuId: currentDefault }) : json({ message: "not found" }, 404);
    }
    if (url.endsWith("/v2/bot/richmenu/list") && method === "GET") return json({ richmenus: menus });
    if (url.endsWith("/v2/bot/richmenu") && method === "POST") return json({ richMenuId: NEW_ID });
    if (url.endsWith(`/richmenu/${NEW_ID}/content`) && method === "POST") return json({});
    const setDefault = url.match(/\/v2\/bot\/user\/all\/richmenu\/(richmenu-[0-9a-f]{32})$/);
    if (setDefault && method === "POST") {
      currentDefault = setDefault[1];
      return json({});
    }
    if (method === "DELETE") return json({});
    return json({ message: `unexpected ${method} ${url}` }, 500);
  };
  const isWrite = (c: Call) => c.method !== "GET" && c.url !== LINE_STATELESS_TOKEN_URL;
  return { calls, fetch, writes: () => calls.filter(isWrite) };
}

function makeDeps(
  fetch: RunnerDeps["fetch"],
  overrides: Partial<Omit<RunnerDeps, "fetch">> = {},
): RunnerDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    fetch,
    env: {
      LINE_CHANNEL_ID: "1234567890",
      LINE_CHANNEL_SECRET: CHANNEL_SECRET,
      LINE_CHANNEL_ID_TEST: "2234567890",
      LINE_CHANNEL_SECRET_TEST: CHANNEL_SECRET,
    },
    readFile: () => fakePng(2500, 843, 50_000),
    defaultImagePath: "/virtual/richmenu.png",
    log: (m) => logs.push(m),
    error: (m) => logs.push(m),
    ...overrides,
    logs,
  };
}

const opt = (o: Partial<CliOptions> & { channel: ChannelKey }): CliOptions => ({
  mode: "apply",
  stateless: true,
  ...o,
});

// ---------------------------------------------------------------------------
console.log("\n--- テスト6: 3 枠の定義 ---");

await it("大きさは 2500x843・3 枠・幅の合計 2500・すべて高さ 843・隙間も重なりも無い", () => {
  const body = buildRichMenuBody(storeUriFor("prod"));
  assertEqual(body.size.width, 2500, "幅");
  assertEqual(body.size.height, 843, "高さ");
  assertEqual(body.areas.length, 3, "枠の数");
  let x = 0;
  for (const a of body.areas) {
    assertEqual(a.bounds.x, x, "枠の左端が前の枠の右端と一致");
    assertEqual(a.bounds.y, 0, "y");
    assertEqual(a.bounds.height, 843, "枠の高さ");
    x += a.bounds.width;
  }
  assertEqual(x, 2500, "幅の合計");
  assertEqual(body.areas.map((a) => a.bounds.width).join("/"), "833/833/834", "列幅");
});

await it("名前・メニューバーの文字・ラベルが LINE の文字数の上限内（名前 300 / バー 14 / ラベル 20）", () => {
  const body = buildRichMenuBody(storeUriFor("prod"));
  assertEqual(body.name, MENU_NAME, "名前");
  assert(MENU_NAME !== "elxea メインメニュー（6 枠 Option A）", "旧 6 枠と同じ名前だと旧メニューが消える");
  assert(MENU_NAME.length <= 300, "名前が長すぎる");
  assertEqual(body.chatBarText, CHAT_BAR_TEXT, "バー");
  assert(CHAT_BAR_TEXT.length <= 14, "バーの文字が長すぎる");
  for (const a of body.areas) assert(a.action.label.length <= 20, `ラベルが長すぎる: ${a.action.label}`);
  assertEqual(body.selected, true, "selected");
});

await it("①② は既存の話しかけトリガーと完全一致する message アクション", () => {
  const [a1, a2] = buildRichMenuBody(storeUriFor("prod")).areas;
  assert(a1.action.type === "message" && a2.action.type === "message", "①② は message");
  if (a1.action.type !== "message" || a2.action.type !== "message") return;
  assertEqual(a1.action.text, BREW_RICH_MENU_TRIGGER, "① = BREW_RICH_MENU_TRIGGER");
  assertEqual(a2.action.text, DIAGNOSIS_TRIGGER, "② = DIAGNOSIS_TRIGGER");
  assertEqual(a1.action.label, "お茶の淹れ方", "① ラベル");
  assertEqual(a2.action.label, "好み診断", "② ラベル");
});

for (const ch of ["prod", "test"] as const) {
  await it(`③ (${ch}) は uri で、そのチャネルの Worker の /go/store を外のブラウザで開く（https・クエリ付き可・閉じたリンクではない）`, () => {
    const uri = storeUriFor(ch);
    const area = buildRichMenuBody(uri).areas[2];
    assert(area.action.type === "uri", "③ は uri");
    if (area.action.type !== "uri") return;
    assertEqual(area.action.uri, uri, "uri");
    assertEqual(area.action.label, "Amazonストア", "③ ラベル");
    const u = new URL(uri);
    assertEqual(u.protocol, "https:", "https");
    assertEqual(u.origin, CHANNELS[ch].workerOrigin, "チャネルの Worker");
    assert(u.hostname.endsWith(".workers.dev"), "workers.dev の住所");
    assertEqual(u.pathname, STORE_PATH, "パスは /go/store");
    assertEqual(u.searchParams.get("openExternalBrowser"), "1", "openExternalBrowser=1（外のブラウザ）");
    assert(!isClosedSiteLink(uri, false), "閉店中に閉じたリンクと判定されてはいけない");
    assert(uri.length <= 1000, "uri は 1000 文字以内");
  });
}

await it("本番 OA は本番 Worker、テスト OA は staging Worker（取り違えない）", () => {
  assert(storeUriFor("prod") !== storeUriFor("test"), "prod と test の行き先が同じ");
  assertEqual(new URL(storeUriFor("prod")).hostname, "elxea-agent.setaka-on.workers.dev", "prod");
  assertEqual(new URL(storeUriFor("test")).hostname, "elxea-agent-staging.setaka-on.workers.dev", "test");
  assertEqual(CHANNELS.prod.expectedBasicId, "@307tzhkw", "prod basicId");
  assertEqual(CHANNELS.test.expectedBasicId, "@426vlcyb", "test basicId");
});

console.log("\n--- テスト6: 画像 ---");

await it(`コミットした画像 ${DEFAULT_RICH_MENU_IMAGE_PATH} は PNG・2500x843・1,000,000 バイト以下`, () => {
  const path = resolve(REPO_ROOT, DEFAULT_RICH_MENU_IMAGE_PATH);
  assert(existsSync(path), `画像がありません: ${path}`);
  const bytes = new Uint8Array(readFileSync(path));
  const size = readPngSize(bytes);
  assert(size, "PNG ではない");
  assertEqual(size.width, RICH_MENU_SIZE.width, "幅");
  assertEqual(size.height, RICH_MENU_SIZE.height, "高さ");
  assert(bytes.length <= 1_000_000, `容量 ${bytes.length} バイトが 1,000,000 を超える`);
  assertEqual(RICH_MENU_IMAGE_MAX_BYTES, 1_000_000, "しきい値");
  assertEqual(validateRichMenuImage(bytes).length, 0, "検査で問題なし");
});

await it("大きさ違い・PNG でない・容量超過は検査で落ちる", () => {
  assert(validateRichMenuImage(fakePng(2500, 1686)).some((p) => p.includes("2500x1686")), "旧 6 枠の大きさ");
  assert(validateRichMenuImage(new Uint8Array(100)).some((p) => p.includes("PNG")), "PNG でない");
  assert(
    validateRichMenuImage(fakePng(2500, 843, 1_000_001)).some((p) => p.includes("1,000,001")),
    "1,000,001 バイト",
  );
  assertEqual(validateRichMenuImage(fakePng(2500, 843, 1_000_000)).length, 0, "ちょうど 1,000,000 バイトは可");
});

console.log("\n--- 引数 ---");

await it("--channel は必須・知らない引数と誤った組み合わせは何もせず失敗", () => {
  const p1 = parseCliArgs(["--", "--channel", "prod", "--stateless"]);
  assert(p1.ok && p1.options.mode === "apply" && p1.options.stateless && p1.options.channel === "prod", "apply");
  const p2 = parseCliArgs(["--channel=test", "--list"]);
  assert(p2.ok && p2.options.mode === "list" && !p2.options.stateless, "list");
  const p3 = parseCliArgs(["--channel", "prod", "--set-default", OLD_6SLOT_ID, "--stateless"]);
  assert(p3.ok && p3.options.mode === "set-default" && p3.options.setDefaultId === OLD_6SLOT_ID, "set-default");
  assert(!parseCliArgs(["--stateless"]).ok, "--channel なし");
  assert(!parseCliArgs(["--channel", "staging"]).ok, "不正なチャネル");
  assert(!parseCliArgs(["--channel", "prod", "--stateles"]).ok, "綴り違いのフラグ");
  assert(!parseCliArgs(["--channel", "prod", "--list", "--set-default", OLD_6SLOT_ID]).ok, "list と set-default");
  assert(!parseCliArgs(["--channel", "prod", "--set-default"]).ok, "ID なし");
  assert(!parseCliArgs(["--channel", "prod", "--set-default", "richmenu-xyz"]).ok, "ID の形が違う");
});

await it(".dev.vars の読み取り（コメント・引用符・export）", () => {
  const v = parseDevVars('# c\nA=1\nexport B="two"\nC=\'3\'\n\nBAD\n');
  assertEqual(v.A, "1", "A");
  assertEqual(v.B, "two", "B");
  assertEqual(v.C, "3", "C");
  assertEqual(Object.keys(v).length, 3, "件数");
});

console.log("\n--- テスト8: basicId の照合（違えば書き込みの API を 1 回も呼ばない） ---");

for (const mode of ["apply", "list", "set-default"] as const) {
  await it(`${mode}: prod を指定したのにテスト OA の basicId が返ったら、書き込まずに止まる`, async () => {
    const line = makeLine({ basicId: "@426vlcyb" });
    const deps = makeDeps(line.fetch);
    const code = await runRichMenuCommand(
      opt({ channel: "prod", mode, ...(mode === "set-default" ? { setDefaultId: OLD_6SLOT_ID } : {}) }),
      deps,
    );
    assertEqual(code, 1, "終了コード");
    assertEqual(line.writes().length, 0, "書き込みの呼び出し");
    assertEqual(line.calls.map((c) => `${c.method} ${c.url}`).join(" | "),
      `POST ${LINE_STATELESS_TOKEN_URL} | GET https://api.line.me/v2/bot/info`, "呼んだのはトークン発行と bot 情報だけ");
    assert(deps.logs.some((l) => l.includes("照合 NG") && l.includes("@307tzhkw") && l.includes("@426vlcyb")), "照合 NG の表示");
  });
}

await it("test を指定して本番 OA の basicId が返っても止まる（トークン環境変数の経路でも照合する）", async () => {
  const line = makeLine({ basicId: "@307tzhkw" });
  const deps = makeDeps(line.fetch, { env: { LINE_CHANNEL_ACCESS_TOKEN_TEST: "t" } });
  const code = await runRichMenuCommand(opt({ channel: "test", stateless: false }), deps);
  assertEqual(code, 1, "終了コード");
  assertEqual(line.writes().length, 0, "書き込みの呼び出し");
});

console.log("\n--- 運転モード ---");

await it("--stateless の apply: 発行 → 照合 → 作成 → 画像 → 既定化 → 同名の旧 3 枠だけ削除（旧 6 枠は残す）", async () => {
  const line = makeLine({ basicId: "@307tzhkw" });
  const deps = makeDeps(line.fetch);
  const code = await runRichMenuCommand(opt({ channel: "prod" }), deps);
  assertEqual(code, 0, "終了コード");
  const seq = line.writes().map((c) => `${c.method} ${c.url.replace(/^https:\/\/api(-data)?\.line\.me/, "")}`);
  assertEqual(
    seq.join(" | "),
    [
      "POST /v2/bot/richmenu",
      `POST /v2/bot/richmenu/${NEW_ID}/content`,
      `POST /v2/bot/user/all/richmenu/${NEW_ID}`,
      `DELETE /v2/bot/richmenu/${STALE_3SLOT_ID}`,
    ].join(" | "),
    "書き込みの順番",
  );
  const tokenCall = line.calls[0];
  assertEqual(tokenCall.url, LINE_STATELESS_TOKEN_URL, "最初にステートレストークンを発行");
  const form = new URLSearchParams(String(tokenCall.body));
  assertEqual(form.get("grant_type"), "client_credentials", "grant_type");
  assertEqual(form.get("client_id"), "1234567890", "client_id = LINE_CHANNEL_ID");
  const create = line.calls.find((c) => c.method === "POST" && c.url.endsWith("/v2/bot/richmenu"));
  assert(create, "作成の呼び出し");
  assertEqual(String(create.body), JSON.stringify(buildRichMenuBody(storeUriFor("prod"))), "作成の本文");
  assertEqual(create.headers.Authorization, `Bearer ${STATELESS_TOKEN}`, "発行したトークンを使う");
  const all = deps.logs.join("\n");
  assert(!all.includes(STATELESS_TOKEN) && !all.includes(CHANNEL_SECRET), "トークン・シークレットを表示しない");
  assert(all.includes(`--set-default ${OLD_6SLOT_ID}`), "戻し用に今の既定 ID を表示する");
});

await it("やり直し（今の既定が同名の仮メニュー）では、消える ID を戻し先として案内しない", async () => {
  const line = makeLine({ basicId: "@307tzhkw", defaultId: STALE_3SLOT_ID });
  const deps = makeDeps(line.fetch);
  const code = await runRichMenuCommand(opt({ channel: "prod" }), deps);
  assertEqual(code, 0, "終了コード");
  const all = deps.logs.join("\n");
  assert(!all.includes(`--set-default ${STALE_3SLOT_ID}`), "消える ID を戻し先にしない");
  assert(all.includes("--list で"), "--list で旧 ID を確かめるよう案内");
});

await it("画像が条件を満たさなければ、API を 1 回も呼ばずに止まる", async () => {
  const line = makeLine({ basicId: "@307tzhkw" });
  const code = await runRichMenuCommand(
    opt({ channel: "prod" }),
    makeDeps(line.fetch, { readFile: () => fakePng(2500, 1686, 50_000) }),
  );
  assertEqual(code, 1, "終了コード");
  assertEqual(line.calls.length, 0, "API の呼び出し");
});

await it("--stateless でチャネル ID / シークレットが無ければ、API を呼ばずに止まる", async () => {
  const line = makeLine({ basicId: "@426vlcyb" });
  const deps = makeDeps(line.fetch, { env: { LINE_CHANNEL_SECRET_TEST: "s" } });
  const code = await runRichMenuCommand(opt({ channel: "test" }), deps);
  assertEqual(code, 1, "終了コード");
  assertEqual(line.calls.length, 0, "API の呼び出し");
  assert(deps.logs.some((l) => l.includes("LINE_CHANNEL_ID_TEST")), "足りない名前を表示");
});

await it("--list は読み取りだけで、照合結果・今の既定 ID・一覧を表示する", async () => {
  const line = makeLine({ basicId: "@307tzhkw" });
  const deps = makeDeps(line.fetch);
  const code = await runRichMenuCommand(opt({ channel: "prod", mode: "list" }), deps);
  assertEqual(code, 0, "終了コード");
  assertEqual(line.writes().length, 0, "書き込みなし");
  const all = deps.logs.join("\n");
  assert(all.includes("照合 OK: @307tzhkw"), "照合結果");
  assert(all.includes(`今の既定メニュー: ${OLD_6SLOT_ID}`), "今の既定 ID");
  assert(all.includes(STALE_3SLOT_ID), "一覧");
});

await it("--set-default <旧ID> は 1 回の既定化で元に戻し、読み返して確かめる", async () => {
  const line = makeLine({ basicId: "@307tzhkw", defaultId: NEW_ID });
  const code = await runRichMenuCommand(
    opt({ channel: "prod", mode: "set-default", setDefaultId: OLD_6SLOT_ID }),
    makeDeps(line.fetch),
  );
  assertEqual(code, 0, "終了コード");
  const writes = line.writes();
  assertEqual(writes.length, 1, "書き込みは既定化の 1 回だけ");
  assert(writes[0].url.endsWith(`/v2/bot/user/all/richmenu/${OLD_6SLOT_ID}`), "旧 ID を既定に");
});

await it("--set-default に一覧に無い ID を渡すと、既定を変えずに止まる", async () => {
  const line = makeLine({ basicId: "@307tzhkw" });
  const code = await runRichMenuCommand(
    opt({ channel: "prod", mode: "set-default", setDefaultId: "richmenu-99999999999999999999999999999999" }),
    makeDeps(line.fetch),
  );
  assertEqual(code, 1, "終了コード");
  assertEqual(line.writes().length, 0, "書き込みなし");
});

await it("--stateless なしでトークンの環境変数が無ければ、API を呼ばずに止まる", async () => {
  const line = makeLine({ basicId: "@307tzhkw" });
  const code = await runRichMenuCommand(opt({ channel: "prod", stateless: false }), makeDeps(line.fetch, { env: {} }));
  assertEqual(code, 1, "終了コード");
  assertEqual(line.calls.length, 0, "API の呼び出し");
});

// ---------------------------------------------------------------------------
console.log("\n============================================================");
console.log("rich-menu-definition.test Results");
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
