/**
 * リッチメニューの運転（LINE API を呼ぶ手順）。読み込んでも何も実行しない。
 * 入口は `scripts/setup-rich-menu.ts`。fetch・環境変数・ファイル読み込みは引数で受け取る（テストで差し替える）。
 *
 * 設計: 実装設計 rev2 第7章（運転モード）/ 第8章（ステートレストークンと basicId の照合）
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *
 * 守ること:
 *   - トークンの値・チャネルシークレットは表示しない・コマンド引数に置かない。
 *   - トークンを得た直後に GET /v2/bot/info で basicId を期待値と照合し、違えば書き込み
 *     （作成・画像・既定化・削除）を 1 回もせずに止める。--list でも照合結果を出す。
 *   - --stateless: POST /oauth2/v3/token（client_credentials）で 15 分のトークンを発行し、メモリ上だけで使う。
 *     本数の上限が無く、他のトークン（本番 Worker が使う 30 日トークン等）を失効させない。
 *     https://developers.line.biz/en/docs/basics/channel-access-token/
 *   - 差し替えは「新作成 → 画像 → 既定化 → 同名の旧メニュー削除」の順（空白の窓を作らない）。
 *     画像は作成より前に検査し、使えなければ何も作らない。
 */

import {
  CHANNELS,
  MENU_NAME,
  RICH_MENU_IMAGE_MAX_BYTES,
  RICH_MENU_SIZE,
  buildRichMenuBody,
  storeUriFor,
  validateRichMenuImage,
  type CliOptions,
} from "./rich-menu-definition";

export const LINE_API_BASE = "https://api.line.me/v2/bot";
export const LINE_API_DATA_BASE = "https://api-data.line.me/v2/bot";
export const LINE_STATELESS_TOKEN_URL = "https://api.line.me/oauth2/v3/token";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RunnerDeps {
  fetch: FetchLike;
  /** process.env に .dev.vars を重ねたもの（値は表示しない）。 */
  env: Record<string, string | undefined>;
  readFile: (path: string) => Uint8Array;
  /** RICH_MENU_IMAGE_PATH が無いときに使う画像の絶対パス。 */
  defaultImagePath: string;
  log: (msg: string) => void;
  error: (msg: string) => void;
}

interface RichMenuSummary {
  richMenuId: string;
  name: string;
  size?: { width: number; height: number };
  areas?: unknown[];
}

/** .dev.vars（KEY=VALUE 形式）を読む。コメントと空行は飛ばし、囲みの引用符を外す。 */
export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 応答本文からエラーの説明だけを取り出す（本文をそのまま出さない）。 */
async function describeError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: string; error_description?: string };
    const parts = [data.message, data.error, data.error_description].filter(
      (v): v is string => typeof v === "string" && v !== "",
    );
    return parts.length > 0 ? parts.join(" / ") : "(説明なし)";
  } catch {
    return "(説明なし)";
  }
}

async function obtainToken(opts: CliOptions, deps: RunnerDeps): Promise<string | null> {
  const ch = CHANNELS[opts.channel];
  if (!opts.stateless) {
    const token = deps.env[ch.env.accessToken];
    if (!token) {
      deps.error(
        `❌ ${ch.env.accessToken} が未設定です（別チャネルのトークンには倒しません）。` +
          "本番のトークンを使わずに済ませるなら --stateless を付けてください。",
      );
      return null;
    }
    deps.log(`🔑 トークン: 環境変数 ${ch.env.accessToken}（値は表示しません）`);
    return token;
  }
  const channelId = deps.env[ch.env.channelId];
  const channelSecret = deps.env[ch.env.channelSecret];
  const missing = [
    !channelId ? ch.env.channelId : null,
    !channelSecret ? ch.env.channelSecret : null,
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) {
    deps.error(`❌ --stateless に必要な ${missing.join(" / ")} が .dev.vars にも環境変数にもありません。`);
    return null;
  }
  const res = await deps.fetch(LINE_STATELESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: channelId as string,
      client_secret: channelSecret as string,
    }).toString(),
  });
  if (!res.ok) {
    deps.error(`❌ ステートレストークンの発行に失敗 [${res.status}]: ${await describeError(res)}`);
    return null;
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    deps.error("❌ ステートレストークンの応答に access_token がありません。");
    return null;
  }
  deps.log("🔑 トークン: ステートレス（15 分で切れる・他のトークンは失効させない・値は表示しません）");
  return data.access_token;
}

/** GET /v2/bot/info の basicId を期待値と照合する。一致したときだけ true。 */
async function verifyBasicId(opts: CliOptions, deps: RunnerDeps, token: string): Promise<boolean> {
  const expected = CHANNELS[opts.channel].expectedBasicId;
  const res = await deps.fetch(`${LINE_API_BASE}/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    deps.error(`❌ bot 情報の取得に失敗 [${res.status}]: ${await describeError(res)}。書き込まずに止めます。`);
    return false;
  }
  const info = (await res.json()) as { basicId?: string };
  const actual = info.basicId ?? "(不明)";
  if (actual !== expected) {
    deps.error(
      `❌ basicId の照合 NG: 期待 ${expected} / 実際 ${actual}。` +
        "違う OA のチャネル ID・シークレット・トークンです。何も書き込まずに止めます。",
    );
    return false;
  }
  deps.log(`✅ basicId の照合 OK: ${actual}`);
  return true;
}

async function getDefaultRichMenuId(deps: RunnerDeps, token: string): Promise<string | null> {
  const res = await deps.fetch(`${LINE_API_BASE}/user/all/richmenu`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`既定メニューの取得に失敗 [${res.status}]: ${await describeError(res)}`);
  const data = (await res.json()) as { richMenuId?: string };
  return data.richMenuId ?? null;
}

async function listRichMenus(deps: RunnerDeps, token: string): Promise<RichMenuSummary[]> {
  const res = await deps.fetch(`${LINE_API_BASE}/richmenu/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`メニュー一覧の取得に失敗 [${res.status}]: ${await describeError(res)}`);
  const data = (await res.json()) as { richmenus?: RichMenuSummary[] };
  return data.richmenus ?? [];
}

async function setDefault(deps: RunnerDeps, token: string, richMenuId: string): Promise<boolean> {
  const res = await deps.fetch(`${LINE_API_BASE}/user/all/richmenu/${richMenuId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    deps.error(`❌ 既定化に失敗 [${res.status}]: ${await describeError(res)}`);
    return false;
  }
  return true;
}

async function runList(deps: RunnerDeps, token: string): Promise<number> {
  const current = await getDefaultRichMenuId(deps, token);
  const menus = await listRichMenus(deps, token);
  deps.log(`\n今の既定メニュー: ${current ?? "(なし)"}`);
  deps.log(`メニュー一覧 (${menus.length} 件):`);
  for (const m of menus) {
    const size = m.size ? `${m.size.width}x${m.size.height}` : "?";
    const mark = m.richMenuId === current ? "  ← 既定" : "";
    deps.log(`  - ${m.richMenuId}  ${m.name}  (${size}・${m.areas?.length ?? "?"} 枠)${mark}`);
  }
  return 0;
}

async function runSetDefault(deps: RunnerDeps, token: string, richMenuId: string): Promise<number> {
  const menus = await listRichMenus(deps, token);
  const target = menus.find((m) => m.richMenuId === richMenuId);
  if (!target) {
    deps.error(`❌ ${richMenuId} はこの OA のメニュー一覧にありません。既定は変えずに止めます（--list で確認）。`);
    return 1;
  }
  const before = await getDefaultRichMenuId(deps, token);
  deps.log(`既定を ${before ?? "(なし)"} → ${richMenuId}（${target.name}）に切り替えます...`);
  if (!(await setDefault(deps, token, richMenuId))) return 1;
  const after = await getDefaultRichMenuId(deps, token);
  if (after !== richMenuId) {
    deps.error(`❌ 切替後の読み返しが一致しません（今の既定: ${after ?? "(なし)"}）。`);
    return 1;
  }
  deps.log(`✅ 既定を ${richMenuId} に切り替えました（トークを開き直すと反映。最大 1 分）。`);
  return 0;
}

async function runApply(opts: CliOptions, deps: RunnerDeps, token: string, image: Uint8Array): Promise<number> {
  const auth = { Authorization: `Bearer ${token}` };
  const before = await getDefaultRichMenuId(deps, token);
  const existing = await listRichMenus(deps, token);
  const staleBefore = existing.filter((m) => m.name === MENU_NAME);
  deps.log(`\n今の既定メニュー: ${before ?? "(なし)"}`);
  // 今の既定が同名の仮メニュー（やり直し）なら、それは差し替え後に消えるので戻し先に使えない。
  const beforeIsStale = before !== null && staleBefore.some((m) => m.richMenuId === before);
  const rollbackId = before && !beforeIsStale ? before : null;
  if (rollbackId) {
    deps.log(`  （元に戻すとき: pnpm setup-rich-menu -- --channel ${opts.channel} --set-default ${rollbackId}${opts.stateless ? " --stateless" : ""}）`);
  } else if (beforeIsStale) {
    deps.log("  （今の既定は同名の仮メニューで、差し替え後に消えます。旧 6 枠へ戻すときは --list で ID を確かめて --set-default）");
  }
  deps.log(
    staleBefore.length > 0
      ? `同名の旧メニュー ${staleBefore.length} 件（新メニューを既定にした後で削除）`
      : "同名の旧メニューはありません",
  );

  const storeUri = storeUriFor(opts.channel);
  deps.log(`\nメニューを作成中...（③ の行き先: ${storeUri}）`);
  const createRes = await deps.fetch(`${LINE_API_BASE}/richmenu`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(buildRichMenuBody(storeUri)),
  });
  if (!createRes.ok) {
    deps.error(`❌ メニュー作成に失敗 [${createRes.status}]: ${await describeError(createRes)}`);
    return 1;
  }
  const { richMenuId } = (await createRes.json()) as { richMenuId: string };
  deps.log(`✅ 作成: ${richMenuId}`);

  const uploadRes = await deps.fetch(`${LINE_API_DATA_BASE}/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "image/png" },
    body: image,
  });
  if (!uploadRes.ok) {
    deps.error(
      `❌ 画像アップロードに失敗 [${uploadRes.status}]: ${await describeError(uploadRes)}。` +
        `既定は変えていません（今の既定のまま）。作成済みの ${richMenuId} は画像なしで残ります。`,
    );
    return 1;
  }
  deps.log("✅ 画像アップロード");

  if (!(await setDefault(deps, token, richMenuId))) {
    deps.error("   旧メニューは削除していません（今の既定のまま＝空白の窓なし）。");
    return 1;
  }
  deps.log("✅ 既定に設定");

  for (const m of staleBefore.filter((s) => s.richMenuId !== richMenuId)) {
    const res = await deps.fetch(`${LINE_API_BASE}/richmenu/${m.richMenuId}`, {
      method: "DELETE",
      headers: auth,
    });
    deps.log(res.ok ? `  同名の旧メニューを削除: ${m.richMenuId}` : `  ⚠ 削除に失敗 [${res.status}]: ${m.richMenuId}`);
  }

  deps.log(
    `\n✅ 差し替え完了: ${richMenuId}（${MENU_NAME}・${RICH_MENU_SIZE.width}x${RICH_MENU_SIZE.height}・1 段 3 列）\n` +
      "   ① お茶の淹れ方 | ② 好み診断 | ③ Amazon ストア（外のブラウザで /go/store）\n" +
      `   元に戻す: --set-default ${rollbackId ?? "<--list で確かめた旧ID>"}（旧 6 枠は名前が違うので消えずに残っている）`,
  );
  return 0;
}

/** 1 回の実行。戻り値は終了コード（0 = 成功）。 */
export async function runRichMenuCommand(opts: CliOptions, deps: RunnerDeps): Promise<number> {
  const ch = CHANNELS[opts.channel];
  deps.log(`🎯 対象チャネル: ${ch.label}（--channel ${opts.channel}・モード ${opts.mode}）`);

  // 画像は何かを書き込む前に検査する（使えなければ API を 1 回も呼ばない）。
  let image: Uint8Array | null = null;
  if (opts.mode === "apply") {
    const imagePath = deps.env.RICH_MENU_IMAGE_PATH || deps.defaultImagePath;
    try {
      image = deps.readFile(imagePath);
    } catch {
      deps.error(`❌ 画像を読めません: ${imagePath}`);
      return 1;
    }
    const problems = validateRichMenuImage(image);
    if (problems.length > 0) {
      deps.error(`❌ 画像が条件を満たしません（${imagePath}）: ${problems.join(" / ")}。何も書き込まずに止めます。`);
      return 1;
    }
    deps.log(`🖼  画像: ${imagePath}（${image.length.toLocaleString("en-US")} / ${RICH_MENU_IMAGE_MAX_BYTES.toLocaleString("en-US")} バイト）`);
  }

  const token = await obtainToken(opts, deps);
  if (!token) return 1;
  if (!(await verifyBasicId(opts, deps, token))) return 1;

  try {
    if (opts.mode === "list") return await runList(deps, token);
    if (opts.mode === "set-default") return await runSetDefault(deps, token, opts.setDefaultId as string);
    return await runApply(opts, deps, token, image as Uint8Array);
  } catch (err) {
    deps.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
