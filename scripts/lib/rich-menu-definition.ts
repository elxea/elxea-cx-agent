/**
 * LINE リッチメニューの定義（仮メニュー 3 枠・Amazon）と、スクリプト引数・画像の検査。
 *
 * 設計: 実装設計 rev2 第7章「3枠の定義」/ 第8章 / 第9章テスト6・8
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *
 * このファイルは読み込んでも何も実行しない（純粋な定義と関数だけ）。テストから読めるように
 * `scripts/setup-rich-menu.ts` から切り出した。LINE API を呼ぶ手順は `./rich-menu-runner.ts`。
 *
 * 3 枠レイアウト（2500x843px・1 段 3 列・列幅 833 / 833 / 834）:
 *   ① お茶の淹れ方 (message) | ② 好み診断 (message) | ③ Amazon ストア (uri → Worker の /go/store)
 *
 *   ① "お茶の淹れ方を知りたい"            → src/lib/menu-tap.ts BREW_RICH_MENU_TRIGGER（tea-menu 入口）
 *   ② "好みに合うお茶を診断してほしいです" → src/lib/preference-diagnosis.ts DIAGNOSIS_TRIGGER
 *   ③ uri アクション。押してもメッセージは来ない（menu-tap には載らない）。回数は /go/store で数える。
 *      行き先は Worker の転送口 /go/store（購入先 PURCHASE_URL へ 302）。LINE の中のブラウザだと Amazon に
 *      ログインしていない状態になりうるため、`openExternalBrowser=1` を付けて外のブラウザで開く。
 *      根拠（LINE 公式「Opening a URL in an external browser」）:
 *        https://developers.line.biz/en/docs/line-login/using-line-url-scheme/#opening-url-in-external-browser
 *        「openExternalBrowser=1 — Opens target URL, in an external browser」
 *        「These query parameters work for all URLs accessed from the LINE app, except for on LIFF apps.」
 *
 * 旧 6 枠（`elxea メインメニュー（6 枠 Option A）`）とは名前が違うので、この定義を登録しても旧メニューは
 * 消えない（スクリプトは同じ名前のメニューだけを消す）。旧 ID へ `--set-default` すれば元に戻せる。
 */

/** リッチメニュー名（同名の旧メニューだけを差し替え後に消すキー）。 */
export const MENU_NAME = "elxea 仮メニュー（3 枠・Amazon）";

/** トーク画面下部のメニューバーの文字。 */
export const CHAT_BAR_TEXT = "メニュー";

/** メニューの大きさ（画像の大きさと一致させる）。 */
export const RICH_MENU_SIZE = { width: 2500, height: 843 } as const;

/**
 * 画像の容量の上限（バイト）。LINE 公式「Requirements for rich menu image」の「Max file size: 1 MB」を、
 * 単位の取り違えを避けるため 1,000,000 バイトで固定する。
 * https://developers.line.biz/en/reference/messaging-api/#upload-rich-menu-image-requirements
 */
export const RICH_MENU_IMAGE_MAX_BYTES = 1_000_000;

/**
 * 既定の画像（リポジトリの根からの相対パス）。RICH_MENU_IMAGE_PATH で上書きできる。
 * 画像を差し替えるときは、このファイルを同じ名前で置き換えるだけでよい（2500x843・1,000,000 バイト以下は
 * tests/unit/rich-menu-definition.test.ts が固定する）。
 */
export const DEFAULT_RICH_MENU_IMAGE_PATH = "assets/rich-menu/richmenu-temp-3slot-amazon.png";

/** ① お茶の淹れ方（src/lib/menu-tap.ts BREW_RICH_MENU_TRIGGER と一致させる）。 */
export const BREW_MENU_TEXT = "お茶の淹れ方を知りたい";
/** ② 好み診断（src/lib/preference-diagnosis.ts DIAGNOSIS_TRIGGER と一致させる）。 */
export const DIAGNOSIS_MENU_TEXT = "好みに合うお茶を診断してほしいです";

/** ③ の転送口のパス（Worker 側の実装は D4）。 */
export const STORE_PATH = "/go/store";

export type ChannelKey = "prod" | "test";

export interface ChannelDefinition {
  /** 起動時に表示するラベル（トークン等の値は含めない）。 */
  label: string;
  /** GET /v2/bot/info の basicId がこれと一致しなければ、書き込みを 1 回もせずに止める。 */
  expectedBasicId: string;
  /** このチャネルの webhook を受ける Worker の住所（③ の行き先）。 */
  workerOrigin: string;
  /** 読む環境変数の名前（値ではない）。 */
  env: {
    channelId: string;
    channelSecret: string;
    accessToken: string;
  };
}

/**
 * チャネルごとの定義。本番 OA は本番 Worker、テスト OA は staging Worker（docs/deploy-runbook.md の
 * webhook 設定と同じ組）。Worker の住所は wrangler.toml の name と workers_dev = true から決まる。
 */
export const CHANNELS: Record<ChannelKey, ChannelDefinition> = {
  prod: {
    label: "prod(@307tzhkw)",
    expectedBasicId: "@307tzhkw",
    workerOrigin: "https://elxea-agent.setaka-on.workers.dev",
    env: {
      channelId: "LINE_CHANNEL_ID",
      channelSecret: "LINE_CHANNEL_SECRET",
      accessToken: "LINE_CHANNEL_ACCESS_TOKEN",
    },
  },
  test: {
    label: "test(@426vlcyb)",
    expectedBasicId: "@426vlcyb",
    workerOrigin: "https://elxea-agent-staging.setaka-on.workers.dev",
    env: {
      channelId: "LINE_CHANNEL_ID_TEST",
      channelSecret: "LINE_CHANNEL_SECRET_TEST",
      accessToken: "LINE_CHANNEL_ACCESS_TOKEN_TEST",
    },
  },
};

/** ③ の行き先: `<チャネルの Worker>/go/store?openExternalBrowser=1`（外のブラウザで開く）。 */
export function storeUriFor(channel: ChannelKey): string {
  const url = new URL(STORE_PATH, CHANNELS[channel].workerOrigin);
  url.searchParams.set("openExternalBrowser", "1");
  return url.toString();
}

export interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number };
  action:
    | { type: "message"; label: string; text: string }
    | { type: "uri"; label: string; uri: string };
}

export interface RichMenuBody {
  size: { width: number; height: number };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: RichMenuArea[];
}

/** 3 枠のメニュー本体（POST /v2/bot/richmenu に渡す形）。 */
export function buildRichMenuBody(storeUri: string): RichMenuBody {
  return {
    size: { width: RICH_MENU_SIZE.width, height: RICH_MENU_SIZE.height },
    selected: true,
    name: MENU_NAME,
    chatBarText: CHAT_BAR_TEXT,
    areas: [
      {
        bounds: { x: 0, y: 0, width: 833, height: 843 },
        action: { type: "message", label: "お茶の淹れ方", text: BREW_MENU_TEXT },
      },
      {
        bounds: { x: 833, y: 0, width: 833, height: 843 },
        action: { type: "message", label: "好み診断", text: DIAGNOSIS_MENU_TEXT },
      },
      {
        bounds: { x: 1666, y: 0, width: 834, height: 843 },
        action: { type: "uri", label: "Amazonストア", uri: storeUri },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 画像の検査（PNG の見出しから大きさを読む。外部ライブラリは使わない）
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG なら幅と高さを返す（IHDR を読む）。PNG でなければ null。 */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  // 8..11 = IHDR の長さ, 12..15 = "IHDR", 16..19 = 幅, 20..23 = 高さ（ビッグエンディアン）
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** 画像がこのメニューに使えるか。使えない理由を返す（空なら使える）。 */
export function validateRichMenuImage(bytes: Uint8Array): string[] {
  const problems: string[] = [];
  const size = readPngSize(bytes);
  if (!size) {
    problems.push("PNG ではありません");
  } else if (size.width !== RICH_MENU_SIZE.width || size.height !== RICH_MENU_SIZE.height) {
    problems.push(
      `大きさが ${size.width}x${size.height} です（${RICH_MENU_SIZE.width}x${RICH_MENU_SIZE.height} が必要）`,
    );
  }
  if (bytes.length > RICH_MENU_IMAGE_MAX_BYTES) {
    problems.push(
      `容量が ${bytes.length.toLocaleString("en-US")} バイトです（${RICH_MENU_IMAGE_MAX_BYTES.toLocaleString("en-US")} バイト以下が必要）`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// スクリプト引数
// ---------------------------------------------------------------------------

export type RunMode = "apply" | "list" | "set-default";

export interface CliOptions {
  channel: ChannelKey;
  mode: RunMode;
  /** mode = set-default のときの戻し先 ID。 */
  setDefaultId?: string;
  /** true なら .dev.vars のチャネル ID とシークレットから 15 分のステートレストークンを発行して使う。 */
  stateless: boolean;
}

export const RICH_MENU_ID_RE = /^richmenu-[0-9a-f]{32}$/;

export const USAGE =
  "使い方:\n" +
  "  pnpm setup-rich-menu -- --channel prod|test [--stateless]            3 枠メニューを作って既定にする\n" +
  "  pnpm setup-rich-menu -- --channel prod|test --list [--stateless]     照合結果・一覧・今の既定 ID を表示（読み取りのみ）\n" +
  "  pnpm setup-rich-menu -- --channel prod|test --set-default <ID> [--stateless]  既定を指定 ID に戻す\n" +
  "  --stateless: .dev.vars のチャネル ID とシークレットから 15 分で切れるトークンを発行して使う（他のトークンを失効させない）";

/** 引数を読む。知らないフラグや組み合わせの誤りは、何も実行しないよう失敗として返す。 */
export function parseCliArgs(
  argv: string[],
): { ok: true; options: CliOptions } | { ok: false; message: string } {
  let channel: string | undefined;
  let list = false;
  let setDefaultId: string | undefined;
  let setDefaultGiven = false;
  let stateless = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue; // pnpm が渡す区切り
    if (arg === "--channel") {
      channel = argv[++i];
    } else if (arg.startsWith("--channel=")) {
      channel = arg.slice("--channel=".length);
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--set-default") {
      setDefaultGiven = true;
      setDefaultId = argv[++i];
    } else if (arg.startsWith("--set-default=")) {
      setDefaultGiven = true;
      setDefaultId = arg.slice("--set-default=".length);
    } else if (arg === "--stateless") {
      stateless = true;
    } else {
      return { ok: false, message: `知らない引数です: ${arg}\n${USAGE}` };
    }
  }

  if (channel !== "prod" && channel !== "test") {
    return {
      ok: false,
      message: `--channel prod|test が未指定または不正です（どちらの OA に載せるかを必ず明示する）。\n${USAGE}`,
    };
  }
  if (list && setDefaultGiven) {
    return { ok: false, message: `--list と --set-default は同時に使えません。\n${USAGE}` };
  }
  if (setDefaultGiven && (!setDefaultId || !RICH_MENU_ID_RE.test(setDefaultId))) {
    return {
      ok: false,
      message: `--set-default には richmenu-（英数字32文字）の ID を渡してください。\n${USAGE}`,
    };
  }
  const mode: RunMode = list ? "list" : setDefaultGiven ? "set-default" : "apply";
  return {
    ok: true,
    options: { channel, mode, stateless, ...(mode === "set-default" ? { setDefaultId } : {}) },
  };
}
