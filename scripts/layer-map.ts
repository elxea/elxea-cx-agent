/**
 * 境界一覧（Layer Map）自動生成 — どのファイルがどの層に属するかをコードから機械抽出する。
 *
 * 目的:
 *   このリポジトリには 2 つの層が同居している。
 *     CDP … データ基盤。顧客データの形・名寄せ・消去・台帳（事実を保持する側）
 *     CX  … 顧客体験。会話・文言・チャネル（事実を使って人に話しかける側）
 *   境界が人の記憶にしか無いと、CX の都合でデータの形を変える / CDP の都合で
 *   文言を書き換える、という事故が起きる。そこで「どのファイルがどちらの層か」を
 *   コード（SoT）から機械生成し、docs/layer-map.md として常に最新に保つ。
 *
 * 判定は 2 系統。上から優先:
 *   1. アノテーション（強い）: ファイル冒頭 JSDoc の `@layer <CDP|CX|shared>` 宣言。
 *      境界が曖昧なファイルにだけ付ける。付いていればパス規則より優先する。
 *      例: ` * @layer CX — CX 所有・CDP を読む（カルテは読むだけで書かない）`
 *   2. パス規則（既定）: ディレクトリ規則 + src/lib の明示リスト（下記 LIB_RULES）。
 *
 *   どちらにも当たらないファイルは `unknown` として一覧に残す（silent drop しない）。
 *   unknown が出たら LIB_RULES に 1 行足すか、当該ファイルに @layer を書くこと。
 *
 * 設計制約:
 *   - 依存ゼロ（node builtins のみ）。どの cwd からでも `npx tsx <this> --repo <path>` で動く。
 *   - ネットワークアクセスなし・外部送信なし。読むだけで、ソースは書き換えない。
 *
 * 実行: npx tsx scripts/layer-map.ts [--repo <repo-root>] [--out <file>] [--json] [--check]
 *   --out <file>  … 出力先（既定 stdout）。docs/layer-map.md の再生成に使う。
 *   --json        … Markdown ではなく JSON を出す（他ツールから読む用）。
 *   --check       … unknown が 1 件でもあれば exit 1（CI の関所用）。
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------
function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.split("=").slice(1).join("=") : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const REPO = resolve(argValue("--repo") ?? process.cwd());
const OUT = argValue("--out");
const AS_JSON = hasFlag("--json");
const CHECK = hasFlag("--check");

// ---------------------------------------------------------------------------
// 層の定義
// ---------------------------------------------------------------------------
type Layer = "CDP" | "CX" | "shared" | "unknown";

const LAYER_DESCRIPTION: Record<Exclude<Layer, "unknown">, string> = {
  CDP: "データ基盤 — スキーマ / マイグレーション / 顧客データ / 名寄せ / 消去 / 台帳。事実を保持する側。",
  CX: "顧客体験 — 会話 / 文言 / チャネル。事実を使って人に話しかける側。",
  shared: "共有基盤 — 環境変数・時刻・認証・ユーティリティ。どちらの層からも使う土台。",
};

// ---------------------------------------------------------------------------
// パス規則 1: ディレクトリ（src/lib 以外はディレクトリで決まる）
// ---------------------------------------------------------------------------
const DIR_RULES: { pattern: RegExp; layer: Layer; why: string }[] = [
  { pattern: /^src\/db\//, layer: "CDP", why: "スキーマとマイグレーション（データの形そのもの）" },
  { pattern: /^src\/lib\/roji\/assignment\//, layer: "CDP", why: "割当エンジン（顧客データからの導出計算）" },
  { pattern: /^src\/lib\/roji\/monthly\//, layer: "CDP", why: "月次割当の実行（台帳への書き込み）" },
  { pattern: /^src\/sync\//, layer: "CDP", why: "外部（Shopify / ナレッジ）からのデータ取り込み" },
  { pattern: /^src\/agent\//, layer: "CX", why: "会話エージェント本体（応答の生成）" },
  { pattern: /^src\/prober\//, layer: "CX", why: "コンテンツ生成と応答品質の検査" },
  { pattern: /^src\/routes\//, layer: "CX", why: "外部からの受け口（チャネルの入口）" },
];

// ---------------------------------------------------------------------------
// パス規則 2: src/lib の明示リスト
//   src/lib は 60 件超がフラットに同居しており、名前の部分一致では誤判定する。
//   よってファイル名を明示列挙する。新しい src/lib のファイルを足したらここに 1 行足すこと
//   （足し忘れは unknown として一覧に出るので、黙って消えることはない）。
// ---------------------------------------------------------------------------
const LIB_RULES: Record<string, { layer: Layer; why: string }> = {
  // --- CDP: 顧客データの保持・名寄せ・消去・台帳 ---
  "account-link.ts": { layer: "CDP", why: "LINE↔Web の名寄せ（本人同定）" },
  "customer-linkage.ts": { layer: "CDP", why: "連携レコードの保持（名寄せの実体）" },
  "identity.ts": { layer: "CDP", why: "本人同定の中核" },
  "karte-merge-rules.ts": { layer: "CDP", why: "カルテ統合ルール（名寄せ時の合流規則）" },
  "karte-reconcile.ts": { layer: "CDP", why: "カルテの突き合わせ・復元" },
  "customer-karte.ts": { layer: "CDP", why: "顧客カルテの保持（事実の格納側）" },
  "roji-erasure.ts": { layer: "CDP", why: "本人データの消去（忘れられる権利の実装）" },
  "delivery-ledger.ts": { layer: "CDP", why: "配送台帳（誰に何がいつ届いたかの事実）" },
  "message-ledger.ts": { layer: "CDP", why: "通数台帳（送信実績の事実）" },
  "delivery-repository.ts": { layer: "CDP", why: "配信データの永続化" },
  "broadcast-stats.ts": { layer: "CDP", why: "配信計測の実績データ" },
  "flow-events.ts": { layer: "CDP", why: "行動イベントの記録" },
  "product-ratings.ts": { layer: "CDP", why: "商品評価データの記録" },
  "purchase-signals.ts": { layer: "CDP", why: "購買シグナルの導出データ" },
  "subscription.ts": { layer: "CDP", why: "定期便の契約状態データ" },
  "subscriber-linkage.ts": { layer: "CDP", why: "定期便顧客の紐付けデータ" },
  "shopify.ts": { layer: "CDP", why: "Shopify 由来の顧客・注文データ" },
  "shopify-order-webhook.ts": { layer: "CDP", why: "注文イベントの取り込み" },
  "firestore.ts": { layer: "CDP", why: "データストア接続" },
  "supabase.ts": { layer: "CDP", why: "データストア接続" },
  "embedding.ts": { layer: "CDP", why: "ベクトル表現の生成・保持" },
  "preference-extractor.ts": { layer: "CDP", why: "会話から嗜好を抽出してデータ化する" },
  "preference-pipeline.ts": { layer: "CDP", why: "嗜好データの更新パイプライン" },
  "roji-survey-record.ts": { layer: "CDP", why: "アンケート回答の記録（事実の格納）" },
  "aggregation-unit.ts": { layer: "CDP", why: "集計単位の定義" },
  "delivery-audience.ts": { layer: "CDP", why: "宛先集合の解決（データ問い合わせ）" },
  "target-resolver.ts": { layer: "CDP", why: "配信対象の解決（データ問い合わせ）" },
  "line-insight.ts": { layer: "CDP", why: "LINE 公式の統計データ取得" },

  // --- CX: 会話・文言・チャネル ---
  "brand-copy.ts": { layer: "CX", why: "ブランド文言の SoT" },
  "brand-guard.ts": { layer: "CX", why: "文言のブランド適合チェック" },
  "flex-templates.ts": { layer: "CX", why: "LINE Flex の見た目" },
  "broadcast-templates.ts": { layer: "CX", why: "配信文面のテンプレート" },
  "line.ts": { layer: "CX", why: "LINE チャネルへの送信" },
  "line-messages.ts": { layer: "CX", why: "LINE メッセージの組み立て" },
  "menu-tap.ts": { layer: "CX", why: "リッチメニュー操作の受け口" },
  "menu-actions.ts": { layer: "CX", why: "リッチメニュー各枠の挙動" },
  "tea-menu.ts": { layer: "CX", why: "お茶メニューの対話" },
  "journal.ts": { layer: "CX", why: "読みもの提示の対話" },
  "feedback-quick-reply.ts": { layer: "CX", why: "感想収集の対話 UI" },
  "preference-diagnosis.ts": { layer: "CX", why: "好み診断の対話（質問の出し方）" },
  "roji-survey.ts": { layer: "CX", why: "アンケートの対話フロー" },
  "roji-survey-copy.ts": { layer: "CX", why: "アンケートの文言" },
  "welcome-onboarding.ts": { layer: "CX", why: "友だち追加時の入口体験" },
  "marche-activation.ts": { layer: "CX", why: "マルシェ来場者への働きかけ" },
  "dormant-reengagement.ts": { layer: "CX", why: "休眠客への静かな一通" },
  "segment-broadcast.ts": { layer: "CX", why: "セグメント配信の文面と送出" },
  "broadcast-optout.ts": { layer: "CX", why: "配信停止の受け付け（対話）" },
  "sales-surface.ts": { layer: "CX", why: "売り込み面の露出制御（何を見せるか）" },
  "query-classifier.ts": { layer: "CX", why: "問い合わせ意図の分類（会話の分岐）" },
  "image-ingest.ts": { layer: "CX", why: "ユーザーが送った画像の受け取り" },

  // --- shared: どちらの層からも使う土台 ---
  "env.ts": { layer: "shared", why: "環境変数" },
  "utils.ts": { layer: "shared", why: "汎用ユーティリティ" },
  "alerts.ts": { layer: "shared", why: "運用アラート通知" },
  "cron-routing.ts": { layer: "shared", why: "定期実行のルーティング" },
  "delivery-channel.ts": { layer: "shared", why: "配信先環境の判定" },
  "delivery-runtime.ts": { layer: "shared", why: "配信実行の共通ランタイム" },
  "delivery-approval.ts": { layer: "shared", why: "配信承認ゲート（安全装置）" },
  "web-auth.ts": { layer: "shared", why: "Web 側の認証" },
  "sync-auth.ts": { layer: "shared", why: "同期処理の認証" },
  "content-hash.ts": { layer: "shared", why: "内容ハッシュ（重複判定の道具）" },
};

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------
/** repo 相対パスを posix 区切りで返す */
function relPosix(abs: string): string {
  return relative(REPO, abs).split(sep).join("/");
}

/** src 配下の .ts を再帰列挙（.d.ts とテストは除く） */
function walk(dirAbs: string, acc: string[] = []): string[] {
  if (!existsSync(dirAbs)) return acc;
  for (const name of readdirSync(dirAbs).sort()) {
    const abs = join(dirAbs, name);
    if (statSync(abs).isDirectory()) {
      walk(abs, acc);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      acc.push(abs);
    }
  }
  return acc;
}

/** ファイル先頭 JSDoc の最初の実質行（説明文）を返す */
function firstDocLine(src: string): string {
  const m = src.match(/\/\*\*\s*\n\s*\*\s*(.+?)\s*\n/);
  return m ? m[1].trim() : "";
}

/**
 * `@layer <LAYER>` アノテーションを読む。
 * 形式: ` * @layer CX — 補足（任意・複数行可）`
 * 補足は em dash / hyphen / コロンのいずれでも受ける。
 * 続く行がインデントされた継続行なら、空行または次の `@タグ` まで連結する
 * （理由が途中で切れた一覧にならないようにするため）。
 */
function readAnnotation(src: string): { layer: Layer; note: string } | null {
  // 先頭 JSDoc ブロックのみを対象にする（本文中の記述を拾わない）
  const block = src.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!block) return null;

  const lines = block[1].split("\n").map((l) => l.replace(/^[ \t]*\*/, "").trim());
  const idx = lines.findIndex((l) => /^@layer\s+(CDP|CX|shared)\b/.test(l));
  if (idx === -1) return null;

  const head = lines[idx].match(/^@layer\s+(CDP|CX|shared)\b[ \t]*(?:[—\-:][ \t]*(.*))?$/);
  if (!head) return null;

  const parts: string[] = [];
  if (head[2]) parts.push(head[2].trim());
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === "" || l.startsWith("@")) break;
    parts.push(l);
  }

  return { layer: head[1] as Layer, note: parts.join(" ").replace(/\s+/g, " ").trim() };
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------
type Entry = {
  file: string;
  layer: Layer;
  source: "annotation" | "path-rule";
  why: string;
  summary: string;
};

function classify(rel: string, src: string): Entry {
  const summary = firstDocLine(src);

  // 1. アノテーション優先
  const ann = readAnnotation(src);
  if (ann) {
    return {
      file: rel,
      layer: ann.layer,
      source: "annotation",
      why: ann.note || "ファイル内の @layer 宣言による",
      summary,
    };
  }

  // 2. ディレクトリ規則（src/lib 直下より先に効かせるため、先に見る）
  for (const rule of DIR_RULES) {
    if (rule.pattern.test(rel)) {
      return { file: rel, layer: rule.layer, source: "path-rule", why: rule.why, summary };
    }
  }

  // 3. src/lib の明示リスト
  const libMatch = rel.match(/^src\/lib\/([^/]+)$/);
  if (libMatch) {
    const hit = LIB_RULES[libMatch[1]];
    if (hit) {
      return { file: rel, layer: hit.layer, source: "path-rule", why: hit.why, summary };
    }
  }

  // 4. src 直下のエントリポイント
  if (/^src\/[^/]+$/.test(rel)) {
    return { file: rel, layer: "shared", source: "path-rule", why: "アプリの起動点（層に属さない配線）", summary };
  }

  return {
    file: rel,
    layer: "unknown",
    source: "path-rule",
    why: "規則にもアノテーションにも当たらない — LIB_RULES に足すか @layer を書くこと",
    summary,
  };
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------
const LAYER_ORDER: Layer[] = ["CDP", "CX", "shared", "unknown"];

function renderMarkdown(entries: Entry[], generatedAt: string): string {
  const byLayer = (l: Layer) => entries.filter((e) => e.layer === l);
  const annotated = entries.filter((e) => e.source === "annotation");
  const unknown = byLayer("unknown");

  const lines: string[] = [];

  lines.push("# 境界一覧（Layer Map）");
  lines.push("");
  lines.push(
    "このリポジトリには **CDP（データ基盤）** と **CX（顧客体験）** の 2 つの層が同居している。" +
      "本ファイルは、どのファイルがどちらの層に属するかの **正本** であり、" +
      "`scripts/layer-map.ts` がコードから自動生成する。"
  );
  lines.push("");
  lines.push("**手で編集しないこと。** 更新するときはコード側を直してから再生成する:");
  lines.push("");
  lines.push("```bash");
  lines.push("npx tsx scripts/layer-map.ts --out docs/layer-map.md");
  lines.push("```");
  lines.push("");
  lines.push(`生成日時: ${generatedAt}`);
  lines.push("");

  lines.push("## 層の定義");
  lines.push("");
  lines.push("| 層 | 意味 |");
  lines.push("|---|---|");
  for (const l of ["CDP", "CX", "shared"] as const) {
    lines.push(`| ${l} | ${LAYER_DESCRIPTION[l]} |`);
  }
  lines.push("");

  lines.push("## 集計");
  lines.push("");
  lines.push("| 層 | ファイル数 |");
  lines.push("|---|---|");
  for (const l of LAYER_ORDER) {
    const n = byLayer(l).length;
    if (l === "unknown" && n === 0) continue;
    lines.push(`| ${l} | ${n} |`);
  }
  lines.push(`| **合計** | **${entries.length}** |`);
  lines.push("");

  lines.push("## 境界が曖昧なファイル（明示宣言あり）");
  lines.push("");
  lines.push(
    "パス規則では割り切れないファイルには、ファイル冒頭に `@layer` を書いて所属を明示している。" +
      "宣言はパス規則より優先される。"
  );
  lines.push("");
  if (annotated.length === 0) {
    lines.push("（現在なし）");
  } else {
    lines.push("| ファイル | 層 | 宣言の理由 |");
    lines.push("|---|---|---|");
    for (const e of annotated) {
      lines.push(`| \`${e.file}\` | ${e.layer} | ${e.why} |`);
    }
  }
  lines.push("");

  if (unknown.length > 0) {
    lines.push("## 要対応: 未分類");
    lines.push("");
    lines.push(
      "以下は規則にもアノテーションにも当たらなかった。`scripts/layer-map.ts` の `LIB_RULES` に 1 行足すか、" +
        "当該ファイルに `@layer` を書くこと。"
    );
    lines.push("");
    for (const e of unknown) lines.push(`- \`${e.file}\``);
    lines.push("");
  }

  for (const l of ["CDP", "CX", "shared"] as const) {
    lines.push(`## ${l}`);
    lines.push("");
    lines.push(LAYER_DESCRIPTION[l]);
    lines.push("");
    lines.push("| ファイル | 根拠 | 概要 |");
    lines.push("|---|---|---|");
    for (const e of byLayer(l)) {
      const mark = e.source === "annotation" ? "宣言" : "パス規則";
      const summary = e.summary ? e.summary.replace(/\|/g, "\\|") : "-";
      lines.push(`| \`${e.file}\` | ${mark}: ${e.why.replace(/\|/g, "\\|")} | ${summary} |`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const files = walk(join(REPO, "src"));
const entries: Entry[] = files.map((abs) => {
  const rel = relPosix(abs);
  return classify(rel, readFileSync(abs, "utf8"));
});

// 層 → ファイル名 の安定ソート
entries.sort((a, b) => {
  const d = LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer);
  return d !== 0 ? d : a.file.localeCompare(b.file);
});

const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const output = AS_JSON
  ? JSON.stringify({ generatedAt, layers: LAYER_DESCRIPTION, entries }, null, 2) + "\n"
  : renderMarkdown(entries, generatedAt);

if (OUT) {
  const abs = resolve(REPO, OUT);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, output, "utf8");
  process.stderr.write(`[layer-map] wrote ${relPosix(abs)} (${entries.length} files)\n`);
} else {
  process.stdout.write(output);
}

const unknownCount = entries.filter((e) => e.layer === "unknown").length;
if (unknownCount > 0) {
  process.stderr.write(`[layer-map] WARN: ${unknownCount} 件が未分類です\n`);
  for (const e of entries.filter((x) => x.layer === "unknown")) {
    process.stderr.write(`[layer-map]   - ${e.file}\n`);
  }
  if (CHECK) process.exit(1);
}
