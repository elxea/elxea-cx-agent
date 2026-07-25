/**
 * REMOVED 2026-07-25（feat/deploy-prod-full）— 旧 ad-hoc runner（staging 単発適用）。
 *
 * 【なぜ hard-stop スタブにしたか（削除ではなく）】
 *   この runner は schema_migrations 台帳に **書かない**ため、実行すると台帳と実 DB が乖離する
 *   drift 源だった。統合 runner scripts/migrate.ts（台帳ベース + introspection baseline）へ一本化する。
 *   ファイルを消さずスタブとして残すのは、(1) 旧コマンドを手癖で叩いた人に ENOENT ではなく明示的な
 *   誘導を返すため、(2) 二度と台帳外適用が起きないよう実行を即時ブロックするため。最小差分で drift を止める。
 *
 * 使い方（台帳ベースの正本）:
 *   npx tsx scripts/migrate.ts --dry-run            # 未適用の確認（非破壊）
 *   npx tsx scripts/migrate.ts --baseline --dry-run # 既存 DB の台帳取り込み検証（非破壊）
 *   npx tsx scripts/migrate.ts --baseline           # 承認後に台帳登録
 *   npx tsx scripts/migrate.ts --apply [--env staging]
 */
console.error(
  "[removed] この ad-hoc runner は廃止（台帳外適用の drift 源）。\n" +
    "  → 統合 runner を使うこと: npx tsx scripts/migrate.ts --dry-run|--baseline|--apply [--env staging]",
);
process.exit(1);

export {};
