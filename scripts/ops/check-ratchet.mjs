#!/usr/bin/env node
// =============================================================================
// check-ratchet.mjs — 撤去の進み具合を CI に固定する (憲章 R8)
//
// 出自:
//   elxea-web-app の scripts/ops/check-ratchet.mjs の移植。仕組み (両方向検査・
//   --update の作法・「見つからないまま 0 と数えない」原則) はそのまま受け継ぎ、
//   数え方 (COUNTERS) だけを cx-agent のものに差し替えてある。
//
// なぜ cx-agent にも要るのか:
//   R8 は「装置導入は全件移行 + 再流入止めで 1 セット」と定める。CDP 統合設計の
//   撤去一覧 (T-1〜T-13) のうち **大半は cx-agent 側にある** (T-4 / T-5 / T-6 /
//   T-7 / T-9 / T-12)。ところが ratchet の仕組みは web-app にしか無く、
//   cx-agent 側の旧経路は「数えられないから締められない」状態だった。
//   数えられないものは、移行が半分で止まっても誰も気づけない。
//   Stage 0 でこれを移植するのは、Stage 1 以降で締める対象を先に数えられる
//   ようにしておくためである (段の順序の理由は統合設計 §6-4)。
//
// 両方向に落とすのが要点:
//   - 実測 > 上限 … 旧経路が増えた。これが止めたい方向。
//   - 実測 < 上限 … 減らしたのに上限が下がっていない。放置すると「減らした分だけ
//                   黙って増やせる枠」が残り、ratchet がゆるむ。
//   つまり **撤去が進むたびに上限を締め直さないと CI が落ちる** ＝ 撤去の進捗
//   そのものが CI に固定される。上限を手で上げる変更は「例外を足したことの申告」
//   として必ず差分に残る。
//
// 使い方:
//   node scripts/ops/check-ratchet.mjs --check    … 検査のみ (CI)。書き込まない
//   node scripts/ops/check-ratchet.mjs --update   … 実測値を ratchets.json へ書く
//
// 新しい表を足すとき:
//   COUNTERS に id と数え方を書き、--update で ratchets.json に 1 行足し、
//   source / why を人が書く。数え方はこのファイルの中に閉じる (数える対象の側に
//   検査を埋め込まない — 隣にあると、対象を増やす変更で数え方も一緒に緩められる)。
//
// CI:
//   static-checks ジョブに相乗りさせる (新規ジョブは作らない)。
// =============================================================================

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const RATCHETS_PATH = join(ROOT, 'ratchets.json');

// --- 走査 --------------------------------------------------------------------

const SKIP_DIR = new Set(['node_modules', 'dist', '.wrangler', 'coverage']);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * 走査対象のソース一覧。
 *
 * `src/db/migrations/**` は除外する。migration は **追記専用の履歴** であり、
 * 「過去にそう書いた」という事実そのものだから、撤去の進捗として数えると
 * 永久に減らない上限を抱えることになる (統合設計 §6-2 の「撤去一覧に載せなかった
 * もの」と同じ理由)。
 */
function sources() {
  const out = [];
  walk(join(ROOT, 'src'), out);
  return out
    .filter((f) => !relative(ROOT, f).split(sep).join('/').startsWith('src/db/migrations/'))
    .sort();
}

const rel = (f) => relative(ROOT, f).split(sep).join('/');

/** 全ソースを (path, text) で回す。 */
function eachSource(fn) {
  for (const file of sources()) fn(rel(file), readFileSync(file, 'utf8'));
}

/**
 * パターンに 1 つでも当たったファイルを数える。
 *
 * **0 件になったら落とす**。数え方が壊れた (対象の書き方が変わった) のと
 * 「本当に全部消えた」のは、上限が 0 になるまで区別がつかない。0 は最終目標で
 * あって既定値ではないので、想定外の 0 は `expectZeroOk` を明示しない限り
 * エラーにする — 見つからないまま 0 と数えるのが最も危険な壊れ方だから。
 */
function countFilesMatching(id, pattern, { expectZeroOk = false } = {}) {
  let n = 0;
  eachSource((_path, text) => {
    pattern.lastIndex = 0;
    if (pattern.test(text)) n += 1;
  });
  if (n === 0 && !expectZeroOk) {
    throw new Error(
      `[check-ratchet] "${id}" の実測が 0 件でした。全部消えたのなら ratchets.json の\n` +
        '    そのエントリに "expect_zero": true を足して「0 が正常である」と申告してください。\n' +
        '    そうでないなら数え方 (COUNTERS) が対象を見失っています — 書き方が変わったか、\n' +
        '    ファイルが移動しています。0 と数えたまま緑にすると検査が永久に空回りします。',
    );
  }
  return n;
}

/** 正規表現に当たった **相異なる文字列** の数 (どの棚が生きているか、を数える)。 */
function countDistinctMatches(id, pattern, extract = (m) => m[1] ?? m[0], { expectZeroOk = false } = {}) {
  const seen = new Set();
  eachSource((_path, text) => {
    for (const m of text.matchAll(pattern)) seen.add(extract(m));
  });
  if (seen.size === 0 && !expectZeroOk) {
    throw new Error(
      `[check-ratchet] "${id}" の実測が 0 種でした。数え方が対象を見失っている可能性が高いです。\n` +
        '    本当に全部消えたなら ratchets.json に "expect_zero": true を足してください。',
    );
  }
  return seen.size;
}

// --- 数え方 ------------------------------------------------------------------
//
// id は ratchets.json の key と一対一。何をなぜ数えるかは ratchets.json の
// source / why に書く (ここには数え方だけを置き、理由を二重に書かない)。

const COUNTERS = {
  /* 統合処理 (T-4 / T-5)。「X を Y に合流させる」形の関数の定義数。
     名前の形 (…IntoShopify / …AnonymousSession) で拾うので、同じ形の関数が
     新しく足されれば当たる。別の名前で書かれた合流までは拾えない — そこは
     Stage 1 の E2 (events gateway 以外の書込を lint で落とす) が受け持つ。 */
  'identity-merge-functions': () =>
    countFilesMatching(
      'identity-merge-functions',
      /export\s+(?:async\s+)?function\s+merge\w*(?:IntoShopify|AnonymousSession)\s*\(/g,
    ),

  /* 別名台帳の冊数 (T-6 / T-7)。Supabase から読み書きしているテーブル名のうち
     identity / linkage を名に含むものの **種類数**。3 冊目が増えれば当たる。

     ⚠ 2026-08-29: 表名を定数に置いたモジュール (`XXX_TABLE = "…"`) を数え落としていた。
        `.from("…")` の字面しか見ていなかったため、定数経由で使えば ratchet の外側に
        台帳を増やせてしまう — 数え方の穴であって「増えていない」ではない。
        定数宣言側も同じ 1 つのパターンで拾う。

     ⚠ 2026-08-29 (Stage 2): 名前に identity / linkage を含む表しか拾えていなかった。
        Stage 2 で足した `subject_links` は **まさにこの表が数えたい台帳**
        (「この LINE とこの顧客は同じ人だ」を書く場所) なのに、名前にどちらの語も
        含まないので数の外に落ちていた。上と同じ種類の穴なので同じように塞ぐ
        — 数え方を広げるのは常に「より多く捕まえる」方向なので、緩めることにはならない。 */
  'identity-ledger-tables': () =>
    countDistinctMatches(
      'identity-ledger-tables',
      /(?:\.from\("|_TABLE\s*=\s*")([a-z_]*(?:identity|linkage|subject_links)[a-z_]*)"/g,
    ),

  /* 人に紐づく Firestore の棚の入口の種類数 (T-8 / T-9)。
     現在 3 種: users/{shopifyId} / users/line:{lineUserId} / lineUsers/{lineUserId}。
     `line:` 前置は同じ users コレクションでも **別の名前空間** として数える
     (web-app の auth-guard.ts が「2 つのキー名前空間は disjoint」と明文化している
     とおり、実体としては別の棚だから)。 */
  'firestore-person-namespaces': () => {
    const found = new Set();
    eachSource((_path, text) => {
      if (/users\/line:/.test(text)) found.add('users/line:{lineUserId}');
      if (/users\/\$\{/.test(text)) found.add('users/{shopifyCustomerId}');
      if (/LINE_USERS_COLLECTION|["'`]lineUsers["'`]/.test(text))
        found.add('lineUsers/{lineUserId}');
    });
    if (found.size === 0) {
      throw new Error(
        '[check-ratchet] "firestore-person-namespaces" の実測が 0 種でした。' +
          '棚のキーの作り方が変わっています。数え方を直してください。',
      );
    }
    return found.size;
  },

  /* 購入由来 persona の書き手 (T-1)。購入の重み定数を使うモジュール数を数える。
     ⚠ この数は **cx-agent 側だけ** を数える。web-app 側の書き手は web-app の
        ratchets.json が別に数える (2 リポにまたがる 1 つの数は作れないため、
        「cx-agent 1 本 + web-app 0 本 = 全体で 1 本」の形で固定する)。 */
  'persona-writers': () =>
    countFilesMatching(
      'persona-writers',
      /\bPURCHASE_SIGNAL_WEIGHT\b/g,
    ) - 1 /* 定義元 purchase-signals.ts を除く */,

  /* 顧客の事実を **L0 以外** に直接書いている面の数 (E2 / Stage 1)。
     数えるのは「書き込みの口」であって呼び出し側ではない — 呼び出し側まで数えると、
     読み手を消さないと数が減らないことになる (raw-identity-key-legacy と同じ考え方)。
     events gateway が透過で包んでいる 5 経路のうち、実際に外部ストアへ書く面がこれ。 */
  'customer-fact-write-sites': () =>
    countFilesMatching(
      'customer-fact-write-sites',
      /\.from\(FLOW_EVENTS_TABLE\)\s*\.insert|\.from\(PRODUCT_RATINGS_TABLE\)\s*\.insert|await addBehaviorEvent\(|await deps\.updateShopifyProfile\(|await deps\.updateLineProfile\(/g,
    ),

  /* 顧客の出来事の語彙を宣言している **名前の種類数** (D3 / D4)。
     行動語彙が 14/10/7 に三分裂し、channel が 4 者で食い違っている状態を数える。
     ファイル数ではなく名前で数えるのは、1 ファイルに 2 つ宣言があっても
     「語彙が 2 つある」ことに変わりはないから。 */
  'event-vocabulary-declarations': () =>
    countDistinctMatches(
      'event-vocabulary-declarations',
      /(?:export\s+)?(?:type|const)\s+(BehaviorAction|BehaviorChannel|FlowEventName|RatingSource|VALID_WEB_EVENTS|KNOWN_EVENT_TYPES|KNOWN_CHANNELS)\b/g,
    ),

  /* 語彙が合わないという理由だけで顧客の出来事を捨てている箇所 (E1)。
     いまは POST /api/chat/event の 1 か所だけ (VALID_WEB_EVENTS に無い action を 400)。 */
  'event-vocabulary-drop-sites': () =>
    countFilesMatching(
      'event-vocabulary-drop-sites',
      /VALID_WEB_EVENTS\.includes\(/g,
    ),

  /* 生の LINE userId を「保管する」場所 (E5 / T-7)。
     数えるのは参照ではなく **保管**: 行に載せる形 (`line_user_id:`) を持つ
     モジュールの数。参照 (where 句で引くだけ) まで数えると、読み手を消さないと
     数が減らないことになり、E5 が意図する「生 ID の置き場を 1 箇所に寄せる」
     とは別の圧力になってしまう。 */
  'raw-identity-key-legacy': () =>
    countFilesMatching('raw-identity-key-legacy', /line_user_id:\s/g),
};

// --- 本体 --------------------------------------------------------------------

function measure(ratchets) {
  const actual = {};
  for (const [id, count] of Object.entries(COUNTERS)) {
    const expectZero = Boolean(ratchets?.[id]?.expect_zero);
    try {
      actual[id] = count();
    } catch (err) {
      // expect_zero を申告済みなら「0 件で落ちる」は正常なので 0 として通す。
      if (expectZero && /実測が 0/.test(String(err?.message))) {
        actual[id] = 0;
        continue;
      }
      throw err;
    }
  }
  return actual;
}

function loadRatchets() {
  if (!existsSync(RATCHETS_PATH)) {
    throw new Error(
      '[check-ratchet] ratchets.json がありません。' +
        'node scripts/ops/check-ratchet.mjs --update で作ってください。',
    );
  }
  return JSON.parse(readFileSync(RATCHETS_PATH, 'utf8'));
}

const DEFAULT_COMMENT = [
  'GENERATED-ASSISTED FILE — max は scripts/ops/check-ratchet.mjs --update が書く。',
  'source / why は人が書く (何を数えていて、なぜその数が残っているのか)。',
  'max を手で増やすだけの変更は、旧経路を増やしたことの申告である。',
  '検査は両方向: 増えたら落ちる (旧経路が増えた) / 減ったのに max が残っていても落ちる',
  '(緩んだ枠を残すと、その分だけ黙って増やせる)。',
];

/**
 * `--update` の書き戻し。**人が書いたものを 1 文字も落とさない**。
 *
 * 移植元では初版が `{ max, source, why }` を組み立て直して書いており、
 * `note` と `$comment` の後半が --update 1 回で黙って消えていた。
 * 「例外の件数は守るのに、なぜ例外なのかの記録は機械が捨てる」という、
 * この仕組みが最も嫌う形の失敗だったので、既存エントリを丸ごと持ち越して
 * `max` だけ差し替える形を移植側でも守る。
 */
function render(entries, actual, existingComment) {
  const ordered = {};
  for (const id of Object.keys(COUNTERS).sort()) {
    const previous = entries[id];
    ordered[id] = previous
      ? { ...previous, max: actual[id] }
      : { max: actual[id], source: '', why: '' };
  }
  return `${JSON.stringify(
    {
      $comment:
        Array.isArray(existingComment) && existingComment.length > 0
          ? existingComment
          : DEFAULT_COMMENT,
      ratchets: ordered,
    },
    null,
    2,
  )}\n`;
}

function main() {
  const update = process.argv.includes('--update');
  const previous = existsSync(RATCHETS_PATH) ? loadRatchets() : {};
  const existing = previous.ratchets ?? {};
  const actual = measure(existing);

  if (update) {
    writeFileSync(RATCHETS_PATH, render(existing, actual, previous.$comment));
    console.log(`[check-ratchet] wrote ratchets.json (${Object.keys(actual).length} entries)`);
    for (const [id, n] of Object.entries(actual)) console.log(`  ${id} = ${n}`);
    return;
  }

  const ratchets = loadRatchets().ratchets;
  const problems = [];

  for (const [id, n] of Object.entries(actual)) {
    const entry = ratchets[id];
    if (!entry) {
      problems.push(
        `"${id}" が ratchets.json にありません (実測 ${n} 件)。\n` +
          '    → node scripts/ops/check-ratchet.mjs --update で追加してください。',
      );
      continue;
    }
    if (n > entry.max) {
      problems.push(
        `"${id}" の旧経路が増えています: 実測 ${n} / 上限 ${entry.max} (+${n - entry.max})。\n` +
          `      対象: ${entry.source}\n` +
          '    → 足すのではなく撤去してください。どうしても要るなら\n' +
          '      node scripts/ops/check-ratchet.mjs --update で上限を上げ、\n' +
          '      なぜ必要かを PR 本文に書いてください (上限を上げた差分は必ずレビューに乗ります)。',
      );
    } else if (n < entry.max) {
      problems.push(
        `"${id}" の上限が実測より緩んでいます: 実測 ${n} / 上限 ${entry.max} (-${entry.max - n})。\n` +
          `      対象: ${entry.source}\n` +
          '    → 減らしたぶん上限も下げます。node scripts/ops/check-ratchet.mjs --update を実行して\n' +
          '      結果をコミットしてください。緩んだ枠を残すと、その分だけ黙って増やせてしまいます。',
      );
    }
  }

  for (const id of Object.keys(ratchets)) {
    if (!(id in actual)) {
      problems.push(
        `"${id}" は ratchets.json にありますが、数え方 (COUNTERS) がありません。\n` +
          '    → 対象ごと無くなったなら ratchets.json からも消す。まだあるなら\n' +
          '      scripts/ops/check-ratchet.mjs の COUNTERS に数え方を戻してください。',
      );
    }
  }

  const table = Object.keys(actual)
    .sort()
    .map(
      (id) =>
        `  ${id.padEnd(30)} ${String(actual[id]).padStart(4)} / ${ratchets[id]?.max ?? '-'}`,
    )
    .join('\n');

  if (problems.length > 0) {
    console.error('\n[check-ratchet] FAIL — 実測が固定値と合いません (憲章 R8)\n');
    console.error(`${table}\n`);
    for (const p of problems) console.error(`  - ${p}\n`);
    process.exit(1);
  }

  console.log('[check-ratchet] OK — 旧経路の数は全て固定値どおり\n');
  console.log(table);
}

main();
