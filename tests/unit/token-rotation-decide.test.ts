/**
 * Unit Tests -- 統一トークン監視 (elxea-token-rotation) の判定ロジック
 *
 * 何を守るテストか:
 *   トークンの残り寿命を「安全 / 要注意 / 危険 / 不明」に分類する部分と、
 *   チャネル横断で 1 つの結論へ集約する部分を、実際のトークンにもネットワークにも
 *   触れずに検証する。ここが壊れると、期限切れが近いのに緑に見える (= 気づけない)
 *   という最悪の失敗が起きる。
 *
 * 特に守りたい 2 点:
 *   1. UNKNOWN (確認できなかった) を OK に倒さないこと。
 *      probe が壊れている間ずっと安全に見えてしまうのを防ぐ。
 *   2. NON_EXPIRING (無期限が確定) と UNKNOWN を混同しないこと。
 *      この取り違えは elxea-broadcaster の health エンドポイントに実在した不具合で、
 *      「資格情報が無くて確認できない」と「期限が無い」が同じ出力になっていた。
 *
 * 何を呼んでいないか (重要):
 *   統一ランナー scripts/elxea-token-rotation.sh は **一度も起動しない**。
 *   検証対象は副作用ゼロの判定ライブラリ decide.sh だけで、
 *   ネットワーク・資格情報・Vercel・実トークンには一切触れない。
 *   (そのために判定を本体から切り出してある。line-token-rotation と同じ設計。)
 *
 * 使用方法:
 *   npx tsx tests/unit/token-rotation-decide.test.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const DECIDE_LIB =
  "/Users/setaka/.config/admin-pipeline/lib/token-rotation/decide.sh";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(testName: string, fn: () => void) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  } catch (err) {
    failedTests++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${testName}: ${msg}`);
    failures.push({ name: testName, error: msg });
  }
}

function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// bash ヘルパ: 判定ライブラリだけを source して 1 コマンド実行する
// ---------------------------------------------------------------------------
function sh(command: string): string {
  try {
    return execFileSync("/bin/bash", ["-c", `. "${DECIDE_LIB}"; ${command}`], {
      encoding: "utf8",
    }).trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    // 非 0 終了でも stdout は判定結果として意味を持つので返す
    return (e.stdout ?? "").trim();
  }
}

function shStatus(command: string): number {
  try {
    execFileSync("/bin/bash", ["-c", `. "${DECIDE_LIB}"; ${command}`], {
      encoding: "utf8",
    });
    return 0;
  } catch (err: unknown) {
    return (err as { status?: number }).status ?? -1;
  }
}

console.log("\n=== token-rotation decide.sh ===\n");

if (!existsSync(DECIDE_LIB)) {
  console.error(`[FAIL] 判定ライブラリが見つかりません: ${DECIDE_LIB}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log("[trd_epoch_day] 日付の解釈");
// ---------------------------------------------------------------------------

it("1970-01-01 は 0 日", () => {
  assertEqual(sh("trd_epoch_day 1970-01-01"), "0");
});

it("1970-01-02 は 1 日", () => {
  assertEqual(sh("trd_epoch_day 1970-01-02"), "1");
});

it("閏日 2024-02-29 を正しく扱う", () => {
  const feb29 = Number(sh("trd_epoch_day 2024-02-29"));
  const mar01 = Number(sh("trd_epoch_day 2024-03-01"));
  assertEqual(mar01 - feb29, 1, "2/29 の翌日は 3/1");
});

it("時刻付き ISO 文字列は日付部分だけを見る", () => {
  assertEqual(
    sh("trd_epoch_day 2026-08-15T23:59:59Z"),
    sh("trd_epoch_day 2026-08-15"),
  );
});

it("日付として壊れている文字列は非 0 で落ちる", () => {
  if (shStatus("trd_epoch_day notadate") === 0) {
    throw new Error("壊れた入力を受理してしまった");
  }
});

it("空文字も非 0 で落ちる", () => {
  if (shStatus('trd_epoch_day ""') === 0) {
    throw new Error("空文字を受理してしまった");
  }
});

// ---------------------------------------------------------------------------
console.log("\n[trd_days_until] 残余日数");
// ---------------------------------------------------------------------------

it("同日なら 0 日", () => {
  assertEqual(sh("trd_days_until 2026-08-15 2026-08-15"), "0");
});

it("翌日なら 1 日", () => {
  assertEqual(sh("trd_days_until 2026-08-16 2026-08-15"), "1");
});

it("30 日先を正しく数える", () => {
  assertEqual(sh("trd_days_until 2026-09-14 2026-08-15"), "30");
});

it("既に過ぎていれば負の値", () => {
  assertEqual(sh("trd_days_until 2026-08-10 2026-08-15"), "-5");
});

it("月またぎ・年またぎを正しく数える", () => {
  assertEqual(sh("trd_days_until 2027-01-01 2026-12-31"), "1");
});

// ---------------------------------------------------------------------------
console.log("\n[trd_classify] 深刻度の分類");
// ---------------------------------------------------------------------------

it("余裕があれば OK (残 30 日・警告 14 日)", () => {
  assertEqual(sh("trd_classify 30 14 3"), "OK");
});

it("警告しきい値ちょうどは WARN (境界を含む)", () => {
  assertEqual(sh("trd_classify 14 14 3"), "WARN");
});

it("警告しきい値の 1 つ外側は OK", () => {
  assertEqual(sh("trd_classify 15 14 3"), "OK");
});

it("危険しきい値ちょうどは CRITICAL (WARN より優先)", () => {
  assertEqual(sh("trd_classify 3 14 3"), "CRITICAL");
});

it("危険しきい値の 1 つ外側は WARN", () => {
  assertEqual(sh("trd_classify 4 14 3"), "WARN");
});

it("当日失効 (残 0 日) は CRITICAL", () => {
  assertEqual(sh("trd_classify 0 14 3"), "CRITICAL");
});

it("既に失効 (負の残日数) は CRITICAL", () => {
  assertEqual(sh("trd_classify -10 14 3"), "CRITICAL");
});

it("残日数が不明 (-) なら UNKNOWN。OK に倒さない", () => {
  assertEqual(sh("trd_classify - 14 3"), "UNKNOWN");
});

it("残日数が空でも UNKNOWN", () => {
  assertEqual(sh('trd_classify "" 14 3'), "UNKNOWN");
});

it("残日数が数値でなければ UNKNOWN", () => {
  assertEqual(sh("trd_classify abc 14 3"), "UNKNOWN");
});

it("しきい値が壊れていれば UNKNOWN (黙って OK にしない)", () => {
  assertEqual(sh("trd_classify 30 notanumber 3"), "UNKNOWN");
});

it("危険しきい値を省略すると失効済みのみ CRITICAL", () => {
  assertEqual(sh("trd_classify 1 14"), "WARN");
  assertEqual(sh("trd_classify 0 14"), "CRITICAL");
});

it("警告 0 日設定 (無期限チャネル) では残 1 日でも OK にならず境界が効く", () => {
  // warn=0 は「日数では警告しない」設定。残 0 以下だけが CRITICAL になる。
  assertEqual(sh("trd_classify 1 0 0"), "OK");
  assertEqual(sh("trd_classify 0 0 0"), "CRITICAL");
});

// ---------------------------------------------------------------------------
console.log("\n[trd_worst] チャネル横断の集約");
// ---------------------------------------------------------------------------

it("全部 OK なら OK", () => {
  assertEqual(sh("trd_worst OK OK OK"), "OK");
});

it("1 つでも WARN があれば WARN が勝つ", () => {
  assertEqual(sh("trd_worst OK OK WARN OK"), "WARN");
});

it("CRITICAL は WARN より重い", () => {
  assertEqual(sh("trd_worst WARN CRITICAL OK"), "CRITICAL");
});

it("FAIL が最も重い", () => {
  assertEqual(sh("trd_worst CRITICAL FAIL WARN"), "FAIL");
});

it("UNKNOWN は OK より重い (確認できなかったを握り潰さない)", () => {
  assertEqual(sh("trd_worst OK UNKNOWN OK"), "UNKNOWN");
});

it("UNKNOWN は WARN より軽い", () => {
  assertEqual(sh("trd_worst UNKNOWN WARN"), "WARN");
});

it("NON_EXPIRING は OK より軽い (無期限は最も安全)", () => {
  assertEqual(sh("trd_worst NON_EXPIRING OK"), "OK");
});

it("NON_EXPIRING だけなら NON_EXPIRING", () => {
  assertEqual(sh("trd_worst NON_EXPIRING NON_EXPIRING"), "NON_EXPIRING");
});

it("SKIP (対象外) だけなら SKIP", () => {
  assertEqual(sh("trd_worst SKIP SKIP"), "SKIP");
});

it("SKIP は他のどの状態にも勝たない", () => {
  assertEqual(sh("trd_worst SKIP NON_EXPIRING"), "NON_EXPIRING");
  assertEqual(sh("trd_worst SKIP OK"), "OK");
});

it("知らない状態文字列は UNKNOWN 扱い (安全側へ倒す)", () => {
  assertEqual(sh("trd_worst OK WEIRDSTATUS"), "UNKNOWN");
});

it("引数なしなら SKIP (何も確認していない)", () => {
  assertEqual(sh("trd_worst"), "SKIP");
});

it("実運用に近い組み合わせ: 無期限 + 対象外 + OK は OK", () => {
  assertEqual(sh("trd_worst NON_EXPIRING SKIP OK NON_EXPIRING"), "OK");
});

// ---------------------------------------------------------------------------
console.log("\n[trd_exit_code] 終了コードへの変換");
// ---------------------------------------------------------------------------

it("OK は 0", () => {
  assertEqual(sh("trd_exit_code OK"), "0");
});

it("NON_EXPIRING は 0", () => {
  assertEqual(sh("trd_exit_code NON_EXPIRING"), "0");
});

it("SKIP は 0", () => {
  assertEqual(sh("trd_exit_code SKIP"), "0");
});

it("WARN は 1 (黙って 0 で終わらない)", () => {
  assertEqual(sh("trd_exit_code WARN"), "1");
});

it("UNKNOWN は 2 (確認できなかったこと自体をアラートにする)", () => {
  assertEqual(sh("trd_exit_code UNKNOWN"), "2");
});

it("CRITICAL は 3", () => {
  assertEqual(sh("trd_exit_code CRITICAL"), "3");
});

it("FAIL は 3", () => {
  assertEqual(sh("trd_exit_code FAIL"), "3");
});

it("未知の状態は 2 (安全側)", () => {
  assertEqual(sh("trd_exit_code WHATEVER"), "2");
});

// ---------------------------------------------------------------------------
console.log("\n[統合] LINE の運用シナリオを日付で再現する");
// ---------------------------------------------------------------------------

it("発行直後 (残 30 日) は OK", () => {
  const days = sh("trd_days_until 2026-09-14 2026-08-15");
  assertEqual(sh(`trd_classify ${days} 5 2`), "OK");
});

it("25 日目 (残 5 日・更新される日) は WARN として見える", () => {
  const days = sh("trd_days_until 2026-09-14 2026-09-09");
  assertEqual(days, "5");
  assertEqual(sh(`trd_classify ${days} 5 2`), "WARN");
});

it("更新が 2 日前まで走らなければ CRITICAL", () => {
  const days = sh("trd_days_until 2026-09-14 2026-09-12");
  assertEqual(days, "2");
  assertEqual(sh(`trd_classify ${days} 5 2`), "CRITICAL");
});

it("失効当日は CRITICAL", () => {
  const days = sh("trd_days_until 2026-09-14 2026-09-14");
  assertEqual(sh(`trd_classify ${days} 5 2`), "CRITICAL");
});

// ---------------------------------------------------------------------------
console.log("\n[統合] Meta の cron 停止シナリオ");
// ---------------------------------------------------------------------------

it("cron が 15 日間隔で回っていれば残 45 日で OK", () => {
  // 最終更新 2026-08-01 + 有効期間 60 日 = 2026-09-30。2026-08-16 時点で残 45 日。
  const days = sh("trd_days_until 2026-09-30 2026-08-16");
  assertEqual(days, "45");
  assertEqual(sh(`trd_classify ${days} 14 3`), "OK");
});

it("cron が 50 日止まると WARN に落ちる", () => {
  // 最終更新 2026-08-01 + 60 日 = 2026-09-30。2026-09-20 時点で残 10 日。
  const days = sh("trd_days_until 2026-09-30 2026-09-20");
  assertEqual(days, "10");
  assertEqual(sh(`trd_classify ${days} 14 3`), "WARN");
});

it("cron が止まったまま失効直前になれば CRITICAL", () => {
  const days = sh("trd_days_until 2026-09-30 2026-09-28");
  assertEqual(sh(`trd_classify ${days} 14 3`), "CRITICAL");
});

// ---------------------------------------------------------------------------
console.log("\n[回帰] 無期限と確認不能を取り違えない");
// ---------------------------------------------------------------------------

it("無期限チャネルと確認不能チャネルは別の集約結果になる", () => {
  // elxea-broadcaster の health エンドポイントに実在した取り違えの回帰テスト。
  // 「資格情報が無くて確認できない」を「期限なし」と同じ扱いにすると失効を見逃す。
  const nonExpiring = sh("trd_worst NON_EXPIRING NON_EXPIRING");
  const unknown = sh("trd_worst NON_EXPIRING UNKNOWN");
  assertEqual(nonExpiring, "NON_EXPIRING");
  assertEqual(unknown, "UNKNOWN");
  if (nonExpiring === unknown) {
    throw new Error("無期限と確認不能が同じ結果になっている");
  }
  // 終了コードでも区別されること (0 と 2)
  assertEqual(sh(`trd_exit_code ${nonExpiring}`), "0");
  assertEqual(sh(`trd_exit_code ${unknown}`), "2");
});

// ---------------------------------------------------------------------------
console.log(
  `\n=== 結果: ${passedTests}/${totalTests} passed, ${failedTests} failed ===\n`,
);
if (failures.length > 0) {
  console.log("失敗した項目:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);
