/**
 * LINE リッチメニュー設定スクリプト（仮メニュー 3 枠・Amazon / 2026-09-26〜）。
 *
 * ⚠ メニューの形（枠・言葉・行き先）の正本は scripts/lib/rich-menu-definition.ts。手順は
 *   scripts/lib/rich-menu-runner.ts。このファイルは引数と .dev.vars を読んで渡すだけ。
 *   設計: 実装設計 rev2 第7・8章 https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *
 * 使い方（--channel prod|test は必須。どちらの OA かを必ず明示する）:
 *   pnpm setup-rich-menu -- --channel prod --stateless              3 枠メニューを作って既定にする
 *   pnpm setup-rich-menu -- --channel prod --list --stateless       basicId の照合・一覧・今の既定 ID（読み取りのみ）
 *   pnpm setup-rich-menu -- --channel prod --set-default <旧ID> --stateless   既定を旧 ID に戻す（元の 6 枠に戻す）
 *
 * --stateless: .dev.vars（または環境変数）のチャネル ID とシークレットから 15 分で切れるトークンを
 *   発行して使う。本番 Worker が使っているトークンを失効させない。付けないときは従来どおり
 *   LINE_CHANNEL_ACCESS_TOKEN（test は *_TEST）を使う。
 *   読む名前: prod = LINE_CHANNEL_ID / LINE_CHANNEL_SECRET、test = LINE_CHANNEL_ID_TEST / LINE_CHANNEL_SECRET_TEST。
 *   .dev.vars の場所は DEV_VARS_PATH で変えられる（既定は実行したディレクトリの .dev.vars）。
 *   環境変数に同じ名前があればそちらを優先する。
 *
 * どのモードでも、トークンを得た直後に basicId（prod=@307tzhkw / test=@426vlcyb）を照合し、
 * 違えば何も書き込まずに止める。
 *
 * 画像: RICH_MENU_IMAGE_PATH（未指定なら assets/rich-menu/richmenu-temp-3slot-amazon.png）。
 *   2500x843・PNG・1,000,000 バイト以下でなければ何も作らずに止める。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RICH_MENU_IMAGE_PATH, parseCliArgs } from "./lib/rich-menu-definition";
import { parseDevVars, runRichMenuCommand } from "./lib/rich-menu-runner";

const parsed = parseCliArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`❌ ${parsed.message}`);
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devVarsPath = process.env.DEV_VARS_PATH ?? resolve(process.cwd(), ".dev.vars");
// .dev.vars は --stateless のときだけ読む（付けないときは従来どおり export したトークンだけを使う）。
let devVars: Record<string, string> = {};
if (parsed.options.stateless) {
  if (existsSync(devVarsPath)) {
    devVars = parseDevVars(readFileSync(devVarsPath, "utf8"));
  } else {
    console.log(`ℹ️  ${devVarsPath} がありません（環境変数だけを使います）。`);
  }
}

runRichMenuCommand(parsed.options, {
  fetch: (input, init) => fetch(input, init),
  env: { ...devVars, ...process.env },
  readFile: (path) => readFileSync(path),
  defaultImagePath: resolve(repoRoot, DEFAULT_RICH_MENU_IMAGE_PATH),
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
})
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("エラー:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
