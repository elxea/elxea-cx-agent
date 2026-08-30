#!/usr/bin/env node
// =============================================================================
// cdp-acceptance.mjs — 顧客データ統合 (CDP) の受入スイート
//
// 何をするものか:
//   「CDP で作った機能が、いま動いているか」を **機能 ID ごとに** PASS / FAIL で
//   一覧に出す。機能の一覧と合格基準は tests/cdp-acceptance/features.json が正本で、
//   本ファイルはそれを読んで走らせ、結果を機能に割り戻すだけの実行器である。
//
//   正本を JSON に置いて実行器と分けているのは、機能が増えたときに「表に 1 行足す」
//   だけで済ませるため。実行器に機能名が埋まっていると、足し忘れが表に出ない。
//
// なぜ要るのか:
//   Stage 0〜4 で作った機能は 6 つの層 (静的検査 / 単体 / ハーメティック / staging DB /
//   別リポ / 解析リポ) に散っており、それぞれ別のコマンドで走る。全部走らせても
//   「どの **機能** が緑なのか」は誰にも分からない。テストの一覧はテストの言葉で
//   書かれていて、機能の言葉では書かれていないからである。
//   本スイートは機能の言葉 (F-01…) に翻訳した 1 枚を出す。
//
// 判定:
//   PASS    … その機能に紐づく検査が 1 つ以上あり、全部通った
//   FAIL    … 1 つでも落ちた
//   PARTIAL … 通ったものと、前提が無くて走れなかったものが混ざっている
//   SKIP    … 紐づく検査が 1 つも走れなかった (前提が無い)
//   GAP     … 紐づく検査がそもそも 0 件 (= 未カバーの申告。表から隠さない)
//
//   「前提が無い」は具体的には次のどちらか:
//     - tier が要求する環境変数が無い       (例: staging DB の接続情報)
//     - tier が要求する隣のリポジトリが無い (例: ../elxea-web-app)
//   走れなかったことを PASS に混ぜない。混ぜると CI で緑なのに何も検査していない、
//   が起こる (これは検査を持たないのと同じで、いちばん静かに壊れる形である)。
//
// 使い方:
//   node scripts/ops/cdp-acceptance.mjs                 … 走れるものを全部走らせる
//   node scripts/ops/cdp-acceptance.mjs --tier=static,unit,hermetic
//   node scripts/ops/cdp-acceptance.mjs --list          … 走らせずに表だけ出す
//   node scripts/ops/cdp-acceptance.mjs --json          … 機械可読 (CI の成果物向け)
//   node scripts/ops/cdp-acceptance.mjs --strict        … SKIP / PARTIAL / GAP も落とす
//   node scripts/ops/cdp-acceptance.mjs --feature=F-03  … 1 機能だけ
//
// 終了コード:
//   0 … FAIL が 1 件も無い (--strict のときは SKIP / PARTIAL / GAP も無い)
//   1 … 上記に反した
//   2 … スイート自体の設定が壊れている (features.json が読めない・参照先が無い等)
//
// 安全 (このスイートが踏まない線):
//   - 本番には接続しない。db tier は staging の接続情報だけを見る (実際の本番 ref
//     拒否は各 .db.test.ts 側が HARD ASSERT で持っている。二重に持たない)。
//   - 外部送信をしない。LINE / メールを実際に撃つ検査は 1 つも登録しない
//     (features.json 側で `external_send: true` の検査は登録禁止として弾く)。
//   - 実ストアに書かない。書き込みを伴う検査は staging + ROLLBACK のものだけ。
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, isAbsolute } from 'node:path';

const ROOT = process.cwd();
const MANIFEST_PATH = join(ROOT, 'tests', 'cdp-acceptance', 'features.json');

// --- 引数 --------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

const OPT = {
  list: has('--list'),
  json: has('--json'),
  strict: has('--strict'),
  verbose: has('--verbose'),
  tiers: (valueOf('--tier') || '').split(',').map((s) => s.trim()).filter(Boolean),
  features: (valueOf('--feature') || '').split(',').map((s) => s.trim()).filter(Boolean),
};

// --- 正本の読み込み ------------------------------------------------------------

function die(msg) {
  console.error(`[cdp-acceptance] 設定エラー: ${msg}`);
  process.exit(2);
}

if (!existsSync(MANIFEST_PATH)) {
  die(`機能一覧が見つからない: ${MANIFEST_PATH}\n  (リポジトリのルートで実行しているか確認する)`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (e) {
  die(`機能一覧が JSON として読めない: ${e.message}`);
}

const TIERS = manifest.tiers || {};
const CHECKS = manifest.checks || {};
const FEATURES = Array.isArray(manifest.features) ? manifest.features : [];

if (FEATURES.length === 0) die('features が空。機能を 1 件も宣言していない');

// 参照の健全性を先に潰す。走らせてから「そんな検査は無い」と言われても遅い。
for (const f of FEATURES) {
  if (!f.id) die('id を持たない機能がある');
  for (const cid of f.checks || []) {
    if (!CHECKS[cid]) die(`機能 ${f.id} が存在しない検査 ${cid} を参照している`);
  }
}
for (const [cid, chk] of Object.entries(CHECKS)) {
  if (!TIERS[chk.tier]) die(`検査 ${cid} が存在しない tier ${chk.tier} を指している`);
  if (!Array.isArray(chk.cmd) || chk.cmd.length === 0) die(`検査 ${cid} に cmd が無い`);
  // 外部送信を伴う検査はこのスイートに載せない (user CLAUDE.md「外部送信の絶対禁止」)。
  if (chk.external_send) die(`検査 ${cid} が external_send を宣言している。受入スイートに外部送信は載せない`);
}

// --- tier ごとの実行可否 --------------------------------------------------------

/**
 * tier が走れるかを判定する。走れない理由は文字列で返す (表にそのまま出す)。
 * 「無いのに 0 件として通す」ことをしないため、判定は必ず理由付きで返す。
 */
function tierAvailability(tierId) {
  const t = TIERS[tierId];
  if (!t) return { ok: false, reason: `未知の tier ${tierId}` };

  if (OPT.tiers.length > 0 && !OPT.tiers.includes(tierId)) {
    return { ok: false, reason: `--tier で除外` };
  }

  for (const key of t.requires_env || []) {
    if (!process.env[key] || String(process.env[key]).trim() === '') {
      return { ok: false, reason: `環境変数 ${key} が無い` };
    }
  }

  if (t.requires_repo) {
    const p = repoPath(t);
    if (!p) {
      const hint = t.requires_repo_env ? `（${t.requires_repo_env} で明示指定できる）` : "";
      return { ok: false, reason: `隣のリポジトリが無い (${t.requires_repo})${hint}` };
    }
  }

  return { ok: true, reason: null };
}

/**
 * tier が要求するリポジトリの実体を探す。見つからなければ null。
 *
 * 環境変数での明示指定を **先に** 見る。worktree で作業していると「隣」の相対位置が
 * 変わる（作業ツリーが /private/tmp 配下に出るため ../elxea-web-app が存在しない）。
 * 相対位置だけを見ていると、リポジトリは手元にあるのに一律 SKIP になり、
 * 「走らせたつもりで何も検査していない」が起きる。
 */
function repoPath(t) {
  const candidates = [];
  if (t.requires_repo_env && process.env[t.requires_repo_env]) {
    candidates.push(process.env[t.requires_repo_env]);
  }
  candidates.push(isAbsolute(t.requires_repo) ? t.requires_repo : resolve(ROOT, t.requires_repo));

  for (const c of candidates) {
    const p = isAbsolute(c) ? c : resolve(ROOT, c);
    if (!existsSync(p)) continue;
    if (t.requires_repo_file && !existsSync(join(p, t.requires_repo_file))) continue;
    return p;
  }
  return null;
}

/**
 * .dev.vars / .env を読んで process.env に足す。
 *
 * db tier の接続情報はこの 2 ファイルにしか無い (CI には無い)。各 .db.test.ts は
 * 自前で dotenv を読むので実行時は困らないが、**走らせる前に「走れるか」を判定する**
 * には実行器側でも読む必要がある。読まないと、手元でも常に SKIP になる。
 * 値は一切表示しない (キーの有無だけを使う)。
 */
function loadLocalEnvFiles() {
  for (const name of ['.dev.vars', '.env']) {
    const p = join(ROOT, name);
    if (!existsSync(p)) continue;
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue; // 既にあるものは上書きしない
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

loadLocalEnvFiles();

const tierState = {};
for (const tierId of Object.keys(TIERS)) tierState[tierId] = tierAvailability(tierId);

// --- 検査の実行 ----------------------------------------------------------------

const results = {}; // checkId -> { status, ms, reason, output }

function runCheck(cid) {
  if (results[cid]) return results[cid];

  const chk = CHECKS[cid];
  const avail = tierState[chk.tier];
  if (!avail.ok) {
    results[cid] = { status: 'SKIP', ms: 0, reason: avail.reason, output: '' };
    return results[cid];
  }

  const t = TIERS[chk.tier];
  let cwd = ROOT;
  // 隣のリポジトリを要求する tier は、そのリポジトリの中で走らせる。
  // ただし検査が cwd を明示していれば（＝ 隣のリポジトリを「読む」だけで
  // 自リポジトリで走らせたい場合）そちらを優先する。
  if (t.requires_repo) cwd = repoPath(t) ?? ROOT;
  if (chk.cwd) cwd = isAbsolute(chk.cwd) ? chk.cwd : resolve(ROOT, chk.cwd);

  const started = Date.now();
  const [bin, ...args] = chk.cmd;
  const proc = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CDP_ACCEPTANCE: '1' },
    timeout: (chk.timeout_sec || 300) * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - started;

  const output = `${proc.stdout || ''}${proc.stderr || ''}`;
  let status;
  let reason = null;
  if (proc.error && proc.error.code === 'ETIMEDOUT') {
    status = 'FAIL';
    reason = `${chk.timeout_sec || 300}s で時間切れ`;
  } else if (proc.error) {
    status = 'FAIL';
    reason = proc.error.message;
  } else if (proc.status === 0) {
    status = 'PASS';
  } else {
    status = 'FAIL';
    reason = `終了コード ${proc.status}`;
  }

  results[cid] = { status, ms, reason, output };
  return results[cid];
}

// --- 機能への割り戻し ------------------------------------------------------------

function judgeFeature(f) {
  const ids = f.checks || [];
  if (ids.length === 0) return { verdict: 'GAP', checks: [] };

  const per = ids.map((cid) => ({ id: cid, ...results[cid] }));
  const fail = per.filter((r) => r.status === 'FAIL');
  const pass = per.filter((r) => r.status === 'PASS');
  const skip = per.filter((r) => r.status === 'SKIP');

  let verdict;
  if (fail.length > 0) verdict = 'FAIL';
  else if (pass.length === 0) verdict = 'SKIP';
  else if (skip.length > 0) verdict = 'PARTIAL';
  else verdict = 'PASS';

  return { verdict, checks: per };
}

// --- 出力 ---------------------------------------------------------------------

const MARK = { PASS: '[PASS]', FAIL: '[FAIL]', SKIP: '[SKIP]', PARTIAL: '[WARN]', GAP: '[WARN]' };

function pad(s, n) {
  // 全角を 2 幅として数える。等幅で読むための最低限の整形。
  let w = 0;
  for (const ch of String(s)) w += /[　-ヿ㐀-鿿＀-｠]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

function main() {
  const targets = OPT.features.length > 0
    ? FEATURES.filter((f) => OPT.features.includes(f.id))
    : FEATURES;

  if (targets.length === 0) die(`--feature に一致する機能が無い: ${OPT.features.join(',')}`);

  if (OPT.list) {
    console.log('\n=== CDP 機能一覧 (走らせずに表だけ) ===\n');
    for (const f of targets) {
      const tiers = [...new Set((f.checks || []).map((c) => CHECKS[c].tier))].join(',') || '(検査なし)';
      console.log(`${pad(f.id, 7)} ${pad(f.name, 44)} ${pad(tiers, 26)} 検査 ${(f.checks || []).length} 件`);
    }
    console.log(`\n合計 ${targets.length} 機能 / 検査 ${Object.keys(CHECKS).length} 件`);
    return 0;
  }

  // 走れる tier / 走れない tier をまず宣言する。表の読み手が「なぜ SKIP なのか」を
  // 表の下まで読まずに分かるようにするため、先頭に置く。
  console.log('\n=== CDP 受入スイート ===\n');
  console.log('層の実行可否:');
  for (const [tid, t] of Object.entries(TIERS)) {
    const s = tierState[tid];
    console.log(`  ${pad(s.ok ? '[実行]' : '[不可]', 8)} ${pad(tid, 12)} ${pad(t.label || '', 30)} ${s.ok ? '' : `— ${s.reason}`}`);
  }

  // 検査は重複排除して 1 回だけ走らせる (同じコマンドを複数の機能が参照する)。
  const needed = [...new Set(targets.flatMap((f) => f.checks || []))];
  console.log(`\n検査 ${needed.length} 件を実行:\n`);
  for (const cid of needed) {
    const r = runCheck(cid);
    const line = `  ${MARK[r.status]} ${pad(cid, 34)} ${pad(CHECKS[cid].tier, 10)} ${r.status === 'SKIP' ? r.reason : `${r.ms}ms`}`;
    console.log(line);
    if (r.status === 'FAIL') {
      const tail = r.output.split('\n').filter(Boolean).slice(-14);
      for (const l of tail) console.log(`        | ${l}`);
      if (r.reason) console.log(`        | (${r.reason})`);
    } else if (OPT.verbose && r.output) {
      for (const l of r.output.split('\n').filter(Boolean).slice(-6)) console.log(`        | ${l}`);
    }
  }

  const rows = targets.map((f) => ({ f, ...judgeFeature(f) }));

  console.log('\n=== 機能別 判定 ===\n');
  console.log(`  ${pad('ID', 7)} ${pad('判定', 10)} ${pad('機能', 46)} 合格基準`);
  console.log(`  ${'-'.repeat(110)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.f.id, 7)} ${pad(MARK[r.verdict], 10)} ${pad(r.f.name, 46)} ${r.f.criteria || ''}`);
    if (r.verdict === 'FAIL') {
      for (const c of r.checks.filter((c) => c.status === 'FAIL')) {
        console.log(`  ${' '.repeat(18)} └ 落ちた検査: ${c.id} (${c.reason || ''})`);
      }
    } else if (r.verdict === 'SKIP' || r.verdict === 'PARTIAL') {
      const why = [...new Set(r.checks.filter((c) => c.status === 'SKIP').map((c) => c.reason))];
      console.log(`  ${' '.repeat(18)} └ 走れなかった理由: ${why.join(' / ')}`);
    } else if (r.verdict === 'GAP') {
      console.log(`  ${' '.repeat(18)} └ この機能に紐づく検査が 0 件 (未カバーの申告)`);
    }
  }

  const tally = { PASS: 0, FAIL: 0, SKIP: 0, PARTIAL: 0, GAP: 0 };
  for (const r of rows) tally[r.verdict]++;

  console.log(
    `\n=== 合計 ${rows.length} 機能: PASS ${tally.PASS} / PARTIAL ${tally.PARTIAL} / SKIP ${tally.SKIP} / GAP ${tally.GAP} / FAIL ${tally.FAIL} ===`,
  );

  if (OPT.json) {
    const payload = {
      generated_at: new Date().toISOString(),
      tiers: Object.fromEntries(Object.entries(tierState).map(([k, v]) => [k, v])),
      features: rows.map((r) => ({
        id: r.f.id,
        name: r.f.name,
        area: r.f.area,
        criteria: r.f.criteria,
        verdict: r.verdict,
        checks: r.checks.map((c) => ({ id: c.id, tier: CHECKS[c.id].tier, status: c.status, ms: c.ms, reason: c.reason })),
      })),
      tally,
    };
    console.log(`\n---JSON---\n${JSON.stringify(payload, null, 2)}`);
  }

  if (tally.FAIL > 0) {
    console.log('\n落ちた機能がある。上の「落ちた検査」から辿ること。');
    return 1;
  }
  if (OPT.strict && (tally.SKIP > 0 || tally.PARTIAL > 0 || tally.GAP > 0)) {
    console.log('\n--strict: 走れなかった / 未カバーの機能があるため落とす。');
    return 1;
  }
  return 0;
}

process.exit(main());
