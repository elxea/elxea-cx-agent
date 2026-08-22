# 境界一覧（Layer Map）

このリポジトリには **CDP（データ基盤）** と **CX（顧客体験）** の 2 つの層が同居している。本ファイルは、どのファイルがどちらの層に属するかの **正本** であり、`scripts/layer-map.ts` がコードから自動生成する。

**手で編集しないこと。** 更新するときはコード側を直してから再生成する:

```bash
npx tsx scripts/layer-map.ts --out docs/layer-map.md
```

生成日時: 2026-08-22 08:10 UTC

## 層の定義

| 層 | 意味 |
|---|---|
| CDP | データ基盤 — スキーマ / マイグレーション / 顧客データ / 名寄せ / 消去 / 台帳。事実を保持する側。 |
| CX | 顧客体験 — 会話 / 文言 / チャネル。事実を使って人に話しかける側。 |
| shared | 共有基盤 — 環境変数・時刻・認証・ユーティリティ。どちらの層からも使う土台。 |

## 集計

| 層 | ファイル数 |
|---|---|
| CDP | 35 |
| CX | 42 |
| shared | 11 |
| **合計** | **88** |

## 境界が曖昧なファイル（明示宣言あり）

パス規則では割り切れないファイルには、ファイル冒頭に `@layer` を書いて所属を明示している。宣言はパス規則より優先される。

| ファイル | 層 | 宣言の理由 |
|---|---|---|
| `src/lib/account-link.ts` | CDP | CDP 所有。LINE 上の導線に見えるが、本体は「同一人物である」と確定させる名寄せ処理。 連携成立の条件は本人性の判定であり、体験（誘い文句・ボタン）とは切り離して扱う。 セキュリティ境界（SEC-1: email 等値では連携させない）もこの層が守る。 |
| `src/lib/customer-karte.ts` | CDP | CDP 所有。顧客カルテという事実の読み出し口（I/O シーム）であり、 複数の CX 面（会話・次の一杯）へ同じ源から供給する役割を持つ。見せ方は持たない （提示は my-karte＝CX 側）。 |
| `src/lib/delivery-audience.ts` | CDP | CDP 所有。日本語ラベルと内部ペルソナ enum の対応は「顧客をどう区切るか」という データ側の語彙定義であり、配信文面（CX）とは独立に決まる。ここを変えると顧客の分類が 変わるため、CX の都合で書き換えない。 |
| `src/routes/identity.ts` | CDP | CDP 所有。src/routes 配下は既定では CX（チャネルの入口）だが、この経路だけは 例外で、やっていることは本人同定と会話履歴の統合＝名寄せそのもの。 誤って CX 扱いにすると「文言の都合で名寄せ条件を触る」事故につながるため CDP を明示する。 |
| `src/agent/system-prompt.ts` | CX | CX 所有・CDP を読む。この文言は会話の振る舞いを決める体験側の資産であり、 所有は CX にある。CDP が持つ事実（カルテ・嗜好・購買）は personalization-context 経由で 読み込んで文脈に載せるが、ここから CDP のデータを書き換えることはしない。 よって「CDP の都合でこの文面を変える」のは越境であり、変更は CX 側の判断で行う。 |
| `src/lib/delivery-orchestrator.ts` | CX | CX 所有・CDP を読む。宛先集合（delivery-audience / target-resolver）と 通数台帳（message-ledger）は CDP に問い合わせるだけで、ここが決めるのは 「いつ・どの文面を・どのチャネルへ出すか」という体験側の判断。台帳の形は持たない。 |
| `src/lib/my-karte.ts` | CX | CX 所有・CDP を読む。カルテの中身を保持するのは CDP（customer-karte）で、 ここが持つのは「その事実を人間の言葉でどう見せるか」だけ。数値・生スコアを出さない という判断は体験側の責務なので CX に置く。 |
| `src/lib/next-cup.ts` | CX | CX 所有・CDP を読む。カルテ（persona / tasteProfile）と銘柄データを 受け取って「次に何を薦めるか」を決める提案ロジック。データは引数で渡される純粋関数で、 自分では読み書きしない（I/O は customer-karte 側＝CDP が担う）。 |
| `src/lib/personalization-context.ts` | CX | CX 所有・CDP を読む。両層の接合点にあたる。CDP が持つ事実（ペルソナ・嗜好）を 受け取り、会話に載せてよい形の文へ変換する。どの事実を出してよいか（positive/neutral 限定）は 体験側の判断なので CX に置く。事実そのものの保持・更新はしない。 |
| `src/lib/roji-survey-handler.ts` | CX | CX 所有・CDP へ書かせる。ここは LINE 上の対話進行（次に何を聞くか・何を返すか）を 受け持つ。答えの保存そのものは CDP（roji-survey-record）に委ね、ここは呼ぶだけ。 「返す前に器に入れる」という順序は体験の担保なので CX 側の判断として持つ。 |

## CDP

データ基盤 — スキーマ / マイグレーション / 顧客データ / 名寄せ / 消去 / 台帳。事実を保持する側。

| ファイル | 根拠 | 概要 |
|---|---|---|
| `src/lib/account-link.ts` | 宣言: CDP 所有。LINE 上の導線に見えるが、本体は「同一人物である」と確定させる名寄せ処理。 連携成立の条件は本人性の判定であり、体験（誘い文句・ボタン）とは切り離して扱う。 セキュリティ境界（SEC-1: email 等値では連携させない）もこの層が守る。 | LINE Account Link（LINE 純正のアカウント連携）— linkToken 発行 / nonce 発行・消費 / 連携成立。 |
| `src/lib/aggregation-unit.ts` | パス規則: 集計単位の定義 | 配信計測の集計単位（customAggregationUnit）生成 — P0-7a（後付け不可・次回配信までが締切）。 |
| `src/lib/broadcast-stats.ts` | パス規則: 配信計測の実績データ | 配信計測 fetch ジョブ（P0-7b・後付け不可の計測基盤）。 |
| `src/lib/customer-karte.ts` | 宣言: CDP 所有。顧客カルテという事実の読み出し口（I/O シーム）であり、 複数の CX 面（会話・次の一杯）へ同じ源から供給する役割を持つ。見せ方は持たない （提示は my-karte＝CX 側）。 | 「次の一杯」選定用カルテ（persona / tasteProfile）のローダ（fail-safe・I/O シーム）。 |
| `src/lib/customer-linkage.ts` | パス規則: 連携レコードの保持（名寄せの実体） | customer_linkages 連携行の upsert（案A: LIFF 連携の中心ギャップを埋める書き込み経路）。 |
| `src/lib/delivery-audience.ts` | 宣言: CDP 所有。日本語ラベルと内部ペルソナ enum の対応は「顧客をどう区切るか」という データ側の語彙定義であり、配信文面（CX）とは独立に決まる。ここを変えると顧客の分類が 変わるため、CX の都合で書き換えない。 | 配信対象（audience）の日本語 ↔ enum 変換層（純粋・I/O なし）。 |
| `src/lib/delivery-ledger.ts` | パス規則: 配送台帳（誰に何がいつ届いたかの事実） | 配送台帳への書き込み —「誰に・いつ・何が(どの茶葉が)届いたか」を事実として残す。 |
| `src/lib/delivery-repository.ts` | パス規則: 配信データの永続化 | Notion 配信リポジトリ（T5）。 |
| `src/lib/embedding.ts` | パス規則: ベクトル表現の生成・保持 | キャッシュキーを生成する。テキストを正規化（trim + 小文字）して |
| `src/lib/firestore.ts` | パス規則: データストア接続 | Firestore REST API クライアント（Edge runtime 対応） |
| `src/lib/flow-events.ts` | パス規則: 行動イベントの記録 | flow_events — タップ/フローイベント記録（P0-1 / P0-2）。 |
| `src/lib/identity.ts` | パス規則: 本人同定の中核 | Identity Resolver -- unified_user_id 解決 |
| `src/lib/karte-merge-rules.ts` | パス規則: カルテ統合ルール（名寄せ時の合流規則） | 合流（未連携カルテ → 本カルテ）の持ち越し規則 — 宣言的な表。 |
| `src/lib/karte-reconcile.ts` | パス規則: カルテの突き合わせ・復元 | 毎日の照合 — 「連携しているのに合流していない人」を拾い直す（取りこぼしゼロの最後の担保）。 |
| `src/lib/line-insight.ts` | パス規則: LINE 公式の統計データ取得 | LINE Insight API — unit 別イベント統計の取得（P0-7b の取得側・読み取り専用）。 |
| `src/lib/message-ledger.ts` | パス規則: 通数台帳（送信実績の事実） | LINE 通数会計 / 送信ガード module（判定ロジック専用・実送信はしない）。 |
| `src/lib/preference-extractor.ts` | パス規則: 会話から嗜好を抽出してデータ化する | 会話内容から嗜好シグナルを抽出し、TasteProfile / PersonaProfile を更新する。 |
| `src/lib/preference-pipeline.ts` | パス規則: 嗜好データの更新パイプライン | 嗜好抽出パイプライン — 会話完了後・購入完了後に非同期実行する。 |
| `src/lib/product-ratings.ts` | パス規則: 商品評価データの記録 | product_ratings — 商品評価の器と記録・カルテ変換（P0-3）。 |
| `src/lib/purchase-signals.ts` | パス規則: 購買シグナルの導出データ | 購入データからペルソナシグナルを抽出するモジュール。 |
| `src/lib/roji-erasure.ts` | パス規則: 本人データの消去（忘れられる権利の実装） | roji-erasure — 「記録を消す」を全経路に通す唯一の入口。 |
| `src/lib/roji-survey-record.ts` | パス規則: アンケート回答の記録（事実の格納） | roji 最初のアンケート — 答えを器に入れる（カルテ / 出来事の置き場 / 言葉の置き場）。 |
| `src/lib/roji/assignment/s1-engine.ts` | パス規則: 割当エンジン（顧客データからの導出計算） | roji 出し分け S1 割当エンジン（M4-06）— 既にあるものを呼ぶだけの最小実装。 |
| `src/lib/roji/assignment/types.ts` | パス規則: 割当エンジン（顧客データからの導出計算） | roji 出し分け（割当）— 段階を跨いで変えない「入口と出口」の形（M4-03）。 |
| `src/lib/roji/monthly/monthly-run.ts` | パス規則: 月次割当の実行（台帳への書き込み） | roji 月次処理の骨格（S1）— 「対象者を集める → 割当エンジンを呼ぶ → 台帳に書く → 月を締める」だけ。 |
| `src/lib/roji/monthly/period.ts` | パス規則: 月次割当の実行（台帳への書き込み） | roji 月次処理 — 締め対象月（period）の導出だけを持つ純粋モジュール。 |
| `src/lib/shopify-order-webhook.ts` | パス規則: 注文イベントの取り込み | Shopify 注文 webhook の検証・冪等・処理オーケストレーション（受け口を作って待つ）。 |
| `src/lib/shopify.ts` | パス規則: Shopify 由来の顧客・注文データ | Shopify Admin API クライアント（MS6 6.2-6.4）。 |
| `src/lib/subscriber-linkage.ts` | パス規則: 定期便顧客の紐付けデータ | アカウント連携導線（定期便客限定）＋ 定期便判定（ブロック4・staging 先行）。 |
| `src/lib/subscription.ts` | パス規則: 定期便の契約状態データ | 定期便（サブスク）判定モジュール（純粋・I/O なし）。 |
| `src/lib/supabase.ts` | パス規則: データストア接続 | true の場合、channel フィルターを外して全チャネルの会話を取得する。 |
| `src/lib/target-resolver.ts` | パス規則: 配信対象の解決（データ問い合わせ） | 対象解決の汎用化（T4）。 |
| `src/routes/identity.ts` | 宣言: CDP 所有。src/routes 配下は既定では CX（チャネルの入口）だが、この経路だけは 例外で、やっていることは本人同定と会話履歴の統合＝名寄せそのもの。 誤って CX 扱いにすると「文言の都合で名寄せ条件を触る」事故につながるため CDP を明示する。 | Identity Link Route -- POST /api/identity/link |
| `src/sync/knowledge.ts` | パス規則: 外部（Shopify / ナレッジ）からのデータ取り込み | ナレッジ同期モジュール（Workers 互換）。 |
| `src/sync/shopify-metafield.ts` | パス規則: 外部（Shopify / ナレッジ）からのデータ取り込み | Firestore -> Shopify Customer Metafield 同期レイヤー |

## CX

顧客体験 — 会話 / 文言 / チャネル。事実を使って人に話しかける側。

| ファイル | 根拠 | 概要 |
|---|---|---|
| `src/agent/core.ts` | パス規則: 会話エージェント本体（応答の生成） | ストリーミング用コールバック型。 |
| `src/agent/system-prompt.ts` | 宣言: CX 所有・CDP を読む。この文言は会話の振る舞いを決める体験側の資産であり、 所有は CX にある。CDP が持つ事実（カルテ・嗜好・購買）は personalization-context 経由で 読み込んで文脈に載せるが、ここから CDP のデータを書き換えることはしない。 よって「CDP の都合でこの文面を変える」のは越境であり、変更は CX 側の判断で行う。 | elxea Customer Agent の System Prompt。 |
| `src/agent/tools.ts` | パス規則: 会話エージェント本体（応答の生成） | エージェントが使用できるツール定義。 |
| `src/lib/brand-copy.ts` | パス規則: ブランド文言の SoT | ユーザー向けブランド文言の正本集約（single source of truth）。 |
| `src/lib/brand-guard.ts` | パス規則: 文言のブランド適合チェック | brand-guard — ランタイム出力 egress の brand-fact ガード（runtime lint）。 |
| `src/lib/broadcast-optout.ts` | パス規則: 配信停止の受け付け（対話） | 配信 opt-out（受け取り停止 / 再開）の実行 — UX レビュー指摘 #3。 |
| `src/lib/broadcast-templates.ts` | パス規則: 配信文面のテンプレート | セグメント別配信メッセージテンプレート |
| `src/lib/delivery-orchestrator.ts` | 宣言: CX 所有・CDP を読む。宛先集合（delivery-audience / target-resolver）と 通数台帳（message-ledger）は CDP に問い合わせるだけで、ここが決めるのは 「いつ・どの文面を・どのチャネルへ出すか」という体験側の判断。台帳の形は持たない。 | 配信オーケストレータ（T9）。 |
| `src/lib/dormant-reengagement.ts` | パス規則: 休眠客への静かな一通 | 休眠検知＋「静かな一通」（ブロック3-B）— 送信ゲート付きの再エンゲージ機構。 |
| `src/lib/feedback-quick-reply.ts` | パス規則: 感想収集の対話 UI | 会話フィードバック（👍/👎）Quick Reply の生成と提示頻度（監査 #5「常時付与 → 静か原則に整合」）。 |
| `src/lib/flex-templates.ts` | パス規則: LINE Flex の見た目 | LINE Flex Message テンプレート。 |
| `src/lib/image-ingest.ts` | パス規則: ユーザーが送った画像の受け取り | 画像取込（Notion files 一時URL → R2 → 恒久公開URL）。 |
| `src/lib/journal.ts` | パス規則: 読みもの提示の対話 | UX④ 読みもの（ジャーナル記事）の出し分け — カルテのペルソナに合う記事を Flex カードで薦める。 |
| `src/lib/line-messages.ts` | パス規則: LINE メッセージの組み立て | LINE 送信拡張（T6）: multicast / broadcast の message 配列を text/image 可変化。 |
| `src/lib/line.ts` | パス規則: LINE チャネルへの送信 | LINE Webhook の署名を検証する（Web Crypto API — Workers 互換）。 |
| `src/lib/marche-activation.ts` | パス規則: マルシェ来場者への働きかけ | マルシェ入口「番号未送信」活性化ナッジ（spec drift #1）— 送信ゲート付きの短期活性化機構。 |
| `src/lib/menu-actions.ts` | パス規則: リッチメニュー各枠の挙動 | リッチメニュー（5 枠版・オーナー確定 2026-07-13）の決定的（deterministic・LLM 不使用）応答。 |
| `src/lib/menu-tap.ts` | パス規則: リッチメニュー操作の受け口 | menu.tap 判定（P0-1）— リッチメニュー 5 枠のタップを flow_events に記録するための純粋写像。 |
| `src/lib/my-karte.ts` | 宣言: CX 所有・CDP を読む。カルテの中身を保持するのは CDP（customer-karte）で、 ここが持つのは「その事実を人間の言葉でどう見せるか」だけ。数値・生スコアを出さない という判断は体験側の責務なので CX に置く。 | UX② マイカルテ — 「理解されている・機械的でない」プロフィールを 3 枚の Flex カルーセルで返す。 |
| `src/lib/next-cup.ts` | 宣言: CX 所有・CDP を読む。カルテ（persona / tasteProfile）と銘柄データを 受け取って「次に何を薦めるか」を決める提案ロジック。データは引数で渡される純粋関数で、 自分では読み書きしない（I/O は customer-karte 側＝CDP が担う）。 | A-2a 評価後の「次の一杯」— 2 軸データ活用版の選定ロジック（純粋・状態レス）。 |
| `src/lib/personalization-context.ts` | 宣言: CX 所有・CDP を読む。両層の接合点にあたる。CDP が持つ事実（ペルソナ・嗜好）を 受け取り、会話に載せてよい形の文へ変換する。どの事実を出してよいか（positive/neutral 限定）は 体験側の判断なので CX に置く。事実そのものの保持・更新はしない。 | A-1 文脈接続 — AI 会話応答へ「positive/neutral な事実」を注入するプロンプト断片ビルダー（純粋）。 |
| `src/lib/preference-diagnosis.ts` | パス規則: 好み診断の対話（質問の出し方） | 好み診断（リッチメニュー②）— 3 問・全タップ・状態レス・LLM 不使用。 |
| `src/lib/query-classifier.ts` | パス規則: 問い合わせ意図の分類（会話の分岐） | クエリカテゴリ判定（メタデータフィルタリング用） |
| `src/lib/roji-survey-copy.ts` | パス規則: アンケートの文言 | roji 最初のアンケート — **画面に出る文言の正本の写し**（純粋なデータのみ）。 |
| `src/lib/roji-survey-handler.ts` | 宣言: CX 所有・CDP へ書かせる。ここは LINE 上の対話進行（次に何を聞くか・何を返すか）を 受け持つ。答えの保存そのものは CDP（roji-survey-record）に委ね、ここは呼ぶだけ。 「返す前に器に入れる」という順序は体験の担保なので CX 側の判断として持つ。 | roji 最初のアンケート — LINE の配線（読む → 決める → 返す → 器に入れる）。 |
| `src/lib/roji-survey.ts` | パス規則: アンケートの対話フロー | roji 最初のアンケート — LINE の 6 問の導線（純粋ロジック）。 |
| `src/lib/sales-surface.ts` | パス規則: 売り込み面の露出制御（何を見せるか） | 売り込み面（sales surface）の機能ゲート — roji「物販の匂いを出さない」への適合。 |
| `src/lib/segment-broadcast.ts` | パス規則: セグメント配信の文面と送出 | セグメント別自動配信（Cron Trigger） |
| `src/lib/tea-menu.ts` | パス規則: お茶メニューの対話 | 購入者向け・選択式お茶メニュー案内（タップ主体・状態レス）。 |
| `src/lib/welcome-onboarding.ts` | パス規則: 友だち追加時の入口体験 | 入口質問型ウェルカム（ブロック2 — 3動線の入口整備）。 |
| `src/prober/article-generator.ts` | パス規則: コンテンツ生成と応答品質の検査 | Article Generator -- RAG article generation for knowledge gaps |
| `src/prober/content-hub-writer.ts` | パス規則: コンテンツ生成と応答品質の検査 | Content Hub Writer -- Writes generated articles to Notion Content Hub DB |
| `src/prober/duplicate-checker.ts` | パス規則: コンテンツ生成と応答品質の検査 | Duplicate Checker -- Prevents redundant article generation |
| `src/prober/improvement-analyzer.ts` | パス規則: コンテンツ生成と応答品質の検査 | Improvement Analyzer -- Phase 4 of Knowledge Prober |
| `src/prober/question-generator.ts` | パス規則: コンテンツ生成と応答品質の検査 | Question Generator -- AI persona-based question generation |
| `src/prober/regression-runner.ts` | パス規則: コンテンツ生成と応答品質の検査 | Regression Runner -- Weekly regression test execution |
| `src/prober/response-evaluator.ts` | パス規則: コンテンツ生成と応答品質の検査 | Response Evaluator -- CX Agent response quality evaluation |
| `src/prober/types.ts` | パス規則: コンテンツ生成と応答品質の検査 | Knowledge Prober -- Shared type definitions |
| `src/routes/line.ts` | パス規則: 外部からの受け口（チャネルの入口） | オンボーディング Quick Reply のトリガーテキスト（従来 3 択）は |
| `src/routes/shopify-webhook.ts` | パス規則: 外部からの受け口（チャネルの入口） | Shopify 注文 webhook ハンドラ（受け口を作って待つ・稼働で即通電）。 |
| `src/routes/survey.ts` | パス規則: 外部からの受け口（チャネルの入口） | Survey Route -- POST /api/survey |
| `src/routes/web.ts` | パス規則: 外部からの受け口（チャネルの入口） | Web Chat Route — POST /api/chat + GET /api/chat/history |

## shared

共有基盤 — 環境変数・時刻・認証・ユーティリティ。どちらの層からも使う土台。

| ファイル | 根拠 | 概要 |
|---|---|---|
| `src/index.ts` | パス規則: アプリの起動点（層に属さない配線） | 配信の起動経路（2026-08-22 完全オンデマンド化・Setaka 指示）。 |
| `src/lib/alerts.ts` | パス規則: 運用アラート通知 | Alert Monitoring -- 異常検知アラート |
| `src/lib/content-hash.ts` | パス規則: 内容ハッシュ（重複判定の道具） | コンテンツ pinning（TOCTOU 対策）のハッシュ計算。 |
| `src/lib/cron-routing.ts` | パス規則: 定期実行のルーティング | Cron ルーティング（純粋・I/O なし・ユニットテスト可能）。 |
| `src/lib/delivery-approval.ts` | パス規則: 配信承認ゲート（安全装置） | 承認ガード（純粋・I/O なし）。 |
| `src/lib/delivery-channel.ts` | パス規則: 配信先環境の判定 | 2 環境（本番 / テスト）の LINE チャネル切替（設計 確定要件 1）。 |
| `src/lib/delivery-runtime.ts` | パス規則: 配信実行の共通ランタイム | 配信 runtime 配線（T8/T9 の実 I/O 束ね）。 |
| `src/lib/env.ts` | パス規則: 環境変数 | 型安全に環境変数を取得するヘルパー。 |
| `src/lib/sync-auth.ts` | パス規則: 同期処理の認証 | Sync API 認証 -- 共通ヘルパー（X-API-Key / SYNC_API_SECRET） |
| `src/lib/utils.ts` | パス規則: 汎用ユーティリティ | 共通ユーティリティ関数 |
| `src/lib/web-auth.ts` | パス規則: Web 側の認証 | Web Chat 認証・レートリミット。 |

