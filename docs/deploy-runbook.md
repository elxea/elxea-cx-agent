# Deploy Runbook -- elxea-cx-agent

## Pre-Deploy Checklist

1. All unit tests pass: `pnpm test:unit`
2. TypeScript compiles: `pnpm typecheck`
3. No uncommitted changes: `git status`
4. Supabase migrations applied (if any)

## Staging Bring-Up（初回セットアップ: 検証チャネルで staging を立てる）

staging（`elxea-agent-staging`）を「テスト OA（@426vlcyb）」に載せて検証するための初回手順。
**全操作でテストチャネルのトークンを使うこと**（本番 OA @307tzhkw のトークンを絶対に混ぜない）。

> 前提の安全設計:
> - `wrangler.toml [env.staging.vars]` に `DELIVERY_TARGET_ENV = "test"` を固定済み。
>   staging は常にテスト OA を対象にする（`src/lib/delivery-channel.ts` が
>   `LINE_CHANNEL_ACCESS_TOKEN_TEST` を選択）。
> - ⚠ **配信本体（Worker）に実送信スイッチは無い**（2026-08-22撤去）。stagingでも `POST /api/delivery/send-one` に
>   承認済みの 1 行（`pageId`）を指定して叩けば、その行はテストOA（@426vlcyb）へ**実際に送信される**（予定日時は無関係）。
>   逆に、cronの自動配信は無いので**放っておいても送られない**。送信の開閉は、Mac 側の送信パイプラインが読む
>   Notion「LINE配信スイッチ」で行う（`docs/line-delivery-guide.md`「送信を止める・再開する（配信スイッチと緊急停止）」）。詳細は「LINE配信の運用」節を参照。

### 1. secret を staging に投入（値はコミットしない）

`.dev.vars` はローカル `wrangler dev` 用でありデプロイ先には反映されない。staging には
`wrangler secret put ... --env staging` で個別投入する（値は対話入力・履歴に残さない）。

```bash
# LINE テストチャネル（@426vlcyb）— 本番トークンを入れないこと
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN_TEST --env staging
wrangler secret put LINE_CHANNEL_SECRET_TEST       --env staging

# バックエンド系（プロジェクトの実際の必要値に合わせる）
wrangler secret put ANTHROPIC_API_KEY              --env staging
wrangler secret put SUPABASE_URL                   --env staging
wrangler secret put SUPABASE_SERVICE_ROLE_KEY      --env staging
# Firebase / R2 等、配信・画像を検証する場合のみ:
wrangler secret put R2_API_TOKEN                   --env staging
# （FIREBASE_* 等はコードが要求するものだけ投入）

# 投入済み secret 名の確認（値は表示されない）
wrangler secret list --env staging
```

### 2. staging へデプロイ

```bash
pnpm deploy:staging   # = wrangler deploy --env staging
```

### 3. テストチャネルの Webhook を staging URL に登録

LINE Developers Console で **テストチャネル（@426vlcyb）** の Messaging API 設定を開き、
Webhook URL を staging の受け口に向ける（**本番チャネルの Webhook は触らない**）:

```
https://elxea-agent-staging.setaka-on.workers.dev/webhook/line
```

「Webhook の利用」を ON にし、Verify で 200 が返ることを確認する。

### 4. リッチメニューをテストチャネルへ登録

テスト OA（@426vlcyb）に載せる。`--channel test` は必須。トークンは、.dev.vars のテスト用チャネル ID /
シークレット（`LINE_CHANNEL_ID_TEST` / `LINE_CHANNEL_SECRET_TEST`）から 15 分で切れるステートレストークンを
スクリプトの中で発行して使う。発行の直後にbasicIdを照合し、`@426vlcyb` でなければ何も書き込まずに止まる。
`LINE_CHANNEL_ID_TEST` はLINE Developers Consoleの当該チャネル（テストOA）の「基本設定」にあるチャネルIDを `.dev.vars` に転記する（秘密情報ではない）。

```bash
pnpm setup-rich-menu -- --channel test --list --stateless   # 照合結果・今の既定 ID・一覧（読み取りのみ）
pnpm setup-rich-menu -- --channel test --stateless          # 3 枠メニューを作って既定にする（画像も自動で上げる）
```

画像は `assets/rich-menu/richmenu-temp-3slot-amazon.png`（2500x843）が既定で使われる（`RICH_MENU_IMAGE_PATH` で上書き可）。
OA Manager での手作業のアップロードは要らない。詳しくは「リッチメニューの差し替えと戻し方」節。

### 5. スタッフがテスト OA を友だち追加して確認

テスト OA（@426vlcyb）を友だち追加し、リッチメニュー表示・各ボタンの挙動・
CXエージェントとの会話を実機確認する。この段階では配信（broadcast）は起きない
（配信は `POST /api/delivery/send-one` に 1 行を指定して叩いたときだけ。承認しただけでは送られない。2026-09-22〜）。

> 更新（2026-07-27）: stagingでの**実送信検証は実施済み**（写真2枚つき4/4成功・証跡行
> <https://app.notion.com/p/3a970c9d064c8184a005cf763f2331af>）。stagingで実配信を再現する手順・
> 必要secretは「LINE配信の運用」節を参照する（この節は初回ブリングアップの記録）。

> ⚠ 取り違え注意（最重要）: 手順 1・3・4 は **すべてテストチャネル（@426vlcyb）**。
> 本番 OA（@307tzhkw / 友だち約 48 人）のトークン・Webhook・リッチメニューには一切触れない。

## リッチメニューの差し替えと戻し方（2026-09-26〜 仮メニュー 3 枠・Amazon）

メニューの形の正本は `scripts/lib/rich-menu-definition.ts`（① お茶の淹れ方 / ② 好み診断 / ③ Amazon ストア・2500x843・1 段 3 列）。
①② は今の話しかけの言葉（message）。③ は uri で、チャネルごとの Worker の `/go/store?openExternalBrowser=1` を開く
（本番 OA → `https://elxea-agent.setaka-on.workers.dev`、テスト OA → `https://elxea-agent-staging.setaka-on.workers.dev`）。

- `openExternalBrowser=1` は、LINE の中のブラウザではなく外のブラウザで開くための LINE 公式のクエリ。LINE の中のブラウザだと
  Amazon にログインしていない状態になりうるため付ける。根拠: LINE Developers「Opening a URL in an external browser」
  <https://developers.line.biz/en/docs/line-login/using-line-url-scheme/#opening-url-in-external-browser>
  （「openExternalBrowser=1 — Opens target URL, in an external browser」「These query parameters work for all URLs accessed
  from the LINE app, except for on LIFF apps.」）
- `/go/store` は Worker 側の転送口（購入先へ 302・押された回数を記録）。**Worker のデプロイが先**。未デプロイのまま③を押すと開けない。

| やりたいこと | コマンド | LINE への書き込み |
|---|---|---|
| どの OA か・今の既定 ID・一覧を見る | `pnpm setup-rich-menu -- --channel prod --list --stateless` | なし |
| 3 枠を既定にする | `pnpm setup-rich-menu -- --channel prod --stateless` | 作成 → 画像 → 既定化 → 同名の旧メニュー削除 |
| 元（旧 6 枠）に戻す | `pnpm setup-rich-menu -- --channel prod --set-default <控えた旧ID> --stateless` | 既定化 1 回（読み返して確認） |

- `--stateless`: `.dev.vars`（実行したディレクトリのもの。`DEV_VARS_PATH` で変えられる）の `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET`
  （test は `*_TEST`）から 15 分で切れるステートレストークンを発行し、メモリ上だけで使う。本数の上限が無く、本番 Worker が
  使っている 30 日トークン（毎日の自動更新 `com.elxea.line-token-rotation`）を失効させない。値は表示しない。
  長期トークンの再発行・短期トークンの追加発行・`line-token-rotation.sh --force` は使わない。
  根拠: <https://developers.line.biz/en/docs/basics/channel-access-token/>
- basicId の照合: どのモードでも、トークンを得た直後に `GET /v2/bot/info` の basicId を期待値（prod `@307tzhkw` / test `@426vlcyb`）と
  照らし合わせる。違えば作成・画像・既定化・削除のどれも呼ばずに止まる。
- 画像: 既定は `assets/rich-menu/richmenu-temp-3slot-amazon.png`。PNG・2500x843・1,000,000 バイト以下でなければ、何も作らずに止まる
  （LINE 公式「Max file size: 1 MB」を単位の取り違えが無いようバイトで固定。`tests/unit/rich-menu-definition.test.ts` でも固定）。
- 旧 6 枠（`elxea メインメニュー（6 枠 Option A）`）は名前が違うので、差し替えても消えずに残る。差し替えの前に `--list` で
  今の既定 ID を控え、戻すときはその ID を `--set-default` に渡す（2026-08-10 の記録では
  `richmenu-4383dd8074a470e13a19bf2463ef8ee3`。必ず `--list` の実測を使う）。差し替えの実行時にも、画面に
  「元に戻すとき」のコマンドが今の既定 ID つきで出る。
- お客さんの画面への反映は、トークを開き直したとき（最大 1 分）。
- 本番の順番: Worker のデプロイ（`/go/store` と閉店中の文）→ `--list` で旧 ID を控える → 差し替え → `--list` で既定が新 ID か確認。
  本番デプロイと本番メニューの差し替えはSetakaの実施GOが要る（Tier 2）。
- コードも戻すときは、先にメニューを旧IDに戻し（`--set-default <旧ID> --stateless`）、そのあとコードをgit revertして再デプロイする
  （逆順だと、③ の /go/store が無い状態が生じる）。
- 開店時（`src/lib/storefront.ts` の `EC_SITE_OPEN = true`）は、メニュー画像（③ の文字）の作り直しと再登録も要る。

## Staging Deploy

```bash
# 1. Deploy to staging
pnpm deploy:staging

# 2. Verify staging (automated checks)
npx tsx scripts/verify-staging.ts

# 3. Run E2E tests against staging
pnpm test:e2e:web -- --target=https://elxea-agent-staging.setaka-on.workers.dev

# 4. Run LINE E2E tests (requires LINE_CHANNEL_SECRET)
STAGING_WORKER_URL=https://elxea-agent-staging.setaka-on.workers.dev pnpm test:e2e
```

## Production Deploy (Tier 2: Setaka Approval Required)

### 一度きりの必須設定（本番反映の前提・未設定だと承認ゲートが無効）

以下は**コードではなく GitHub 側の設定作業**。`.github/workflows/deploy-prod.yml` は
`environment: production` の Required reviewers を前提にした二重ゲート（confirm 入力 + GitHub 承認）だが、
**この設定を入れないと承認ゲートは実質無効**（誰でも `workflow_dispatch` で本番反映できてしまう）。初回に必ず実施する:

- [ ] **GitHub Environment `production` を作成**（Settings → Environments → New environment）。
- [ ] **Required reviewers に Setaka を追加**（この環境を通す job は Setaka の承認なしに開始しない）。
- [ ] **Environment Secrets を 3 種投入**（値は GitHub 側にのみ保持・リポジトリには書かない）:
      `CLOUDFLARE_API_TOKEN` / `SUPABASE_URL`（本番 ref = `bquqzrbzdzjegdovxalu`）/ `SUPABASE_DB_PASSWORD`。
- [ ] （Worker secret は別系統）本番 Worker の secret は `wrangler secret put` で人手投入する。deploy-prod.sh の
      preflight は**名前の存在だけ**を `wrangler secret list` で確認する（値は検証しない・投入は人手のまま）。

### migration の初回（既存 DB の台帳取り込み = baseline・要 Setaka 承認）

本番/staging は ad-hoc runner で**非連続**に適用されてきたため、`schema_migrations` 台帳が空/部分的。
`--apply` の前に **introspection baseline** を通して「実在が確認できた version のみ」を台帳へ取り込む。
high-water-mark（N 以下は全部適用済み）は使わない。

```bash
# 1. 検証レポートのみ（非破壊・この出力を Setaka 承認に回す）
npx tsx scripts/migrate.ts --baseline --dry-run              # prod
npx tsx scripts/migrate.ts --baseline --dry-run --env staging
# 2. 承認後に台帳登録（単一 tx でアトミック）
npx tsx scripts/migrate.ts --baseline
# 3. 以降は「当てるものを名指しして」適用する
npx tsx scripts/migrate.ts --dry-run              # 未適用一覧の確認（読み取りのみ）
npx tsx scripts/migrate.ts --only 036,037 --apply # 名指し適用（prod refをHARD ASSERT）
```

> ⚠ **本番では bare `migrate.ts --apply` を使わない**（未適用を**全件**当てるため）。
> 本番へ当ててはならない migration が存在する（`024` / `025` = 機能有効化時のみ・`027` = LIFF 連携とセット。
> それぞれ後述）。必ず `--only <versions>` で対象を名指しする。
> `scripts/deploy-prod.sh` も同じ規律で動く（`MIGRATE_ONLY` 必須・未指定は中断／deny-list で二重ガード）。

> ⚠ 旧 ad-hoc runner（`scripts/run-migration-*.ts`）は台帳外適用の drift 源のため hard-stop スタブ化済み。
> migration は必ず `scripts/migrate.ts`（台帳ベース）経由で行う。

### 本番 pending migration の適用手順（Setaka の明示 GO 後のみ実行）

> 現状（2026-07-25 時点）: 本番 `schema_migrations` は baseline 初期化済み（24 version 登録）。
> `npx tsx scripts/migrate.ts --dry-run` は **台帳未登録の全ファイルを pending として 7 件**
> （`000 / 001 / 012 / 024 / 025 / 027 / 030`）表示する。このうち **schema の実変更を伴う"実 pending"は
> `001 / 024 / 025 / 030` の 4 件**。残る `000 / 012 / 027` は **no-sentinel / 冪等設計により台帳未登録が正常**
> （`000` = 台帳自身の bootstrap、`012 / 027` = 実在で一意判定できる正の sentinel を持たない冪等 redefinition。
> baseline は意図的にこれらを登録せず、`--apply` が冪等に再適用する設計）。よって dry-run の「7 件」を見て
> 慌てない。判断対象は実 pending の 4 件（`001 / 024 / 025 / 030`）である。以下は **Setaka の明示 GO
> （Tier 2 承認）を得てから** 実行する手順。GO 前は `--apply` を打たない（この節は手順の記録であって着手許可ではない）。
> 適用前に必ず `npx tsx scripts/migrate.ts --dry-run` で「適用予定 version」を目視確認する。

#### 前提: GitHub Environment `production` の一度きり設定（未設定だと承認ゲートが無効）

pending 適用を deploy-prod workflow 経由で回す場合、本ファイル上部
「Production Deploy > 一度きりの必須設定」の設定が入っていることが前提。未実施なら先に済ませる:

- [ ] GitHub **Settings → Environments → New environment** で `production` を作成。
- [ ] **Required reviewers に Setaka を追加**（この環境を通す job は Setaka 承認なしに開始しない）。
      未設定だと `deploy-prod.yml` の承認ゲートは実質無効（誰でも `workflow_dispatch` で本番反映可能になる）。
- [ ] **Environment Secrets を 3 種投入**（値は GitHub 側のみ・リポジトリに書かない）:
      `CLOUDFLARE_API_TOKEN` / `SUPABASE_URL`（本番 ref = `bquqzrbzdzjegdovxalu`）/ `SUPABASE_DB_PASSWORD`。
- 一度設定すれば恒久。詳細は上部「一度きりの必須設定」を SoT とする（本節は入口の再掲）。

#### 030（006 ドリフト修復・安全・冪等）

- 内容: `unanswered_queries` に `channel`（`ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT 'line'`）と
  `user_id`（`line_user_id`→`user_id` の rename 優先 DO ブロック）を冪等に補う。006 本体は書き換えない。
- 安全性: 全 DDL が冪等。006 が正しく当たっている環境では **完全 no-op**。既存データは backfill / rename のみで破壊しない。
- 適用方法（台帳ベース・単独でよい・オフピーク不要）— ⚠ **必ず `--only 030` で対象を絞る**:

  ```bash
  npx tsx scripts/migrate.ts --only 030 --dry-run   # 030 だけが適用予定に出ることを事前確認（書き込みなし）
  npx tsx scripts/migrate.ts --only 030 --apply     # prod ref を HARD ASSERT のうえ 030 だけを適用
  ```

- ⚠ **bare `--apply`（`--only` なし）は打たない**: migrate.ts は version 選択なしの `--apply` を実行すると
  **pending 全件**（`000 → 001 → 012 → 024 → 025 → 027 → 030` の未登録全ファイル）を番号順に適用する。
  つまり 030 だけのつもりで bare `--apply` を打つと、`001`（ANN index 復旧・要オフピーク／012 同伴が必須）や
  本番未適用が設計の `024 / 025` まで意図せず当ててしまう。**特定 version だけを当てるときは必ず `--only` を付ける。**
- 適用後、introspection sentinel（`unanswered_queries.channel` / `.user_id`）が両方 present になり
  台帳が 030=applied に更新される（`--only 030 --apply` は 030 だけを台帳登録する）。

#### 001（ANN index 欠落の復旧）— ⚠ 単独 `--apply` は不可・012 と同一実行で完走させる

- 内容: `knowledge_chunks.embedding` を `vector(1024)` に揃え、ivfflat index
  `knowledge_chunks_embedding_idx (lists=100)` を drop→再作成し、**3 引数版** `search_knowledge` を再作成する。
- ⚠ **オーバーロード衝突（最重要）**: 本番は 012 適用済みで `search_knowledge` は **4 引数版**（`filter_source_type` 付き）。
  001 の末尾は **3 引数版** `search_knowledge` を `create or replace` するため、**001 だけを適用すると 3 引数版が増設され、
  4 引数版と共存 → PostgREST がオーバーロード解決に失敗**する（012 が消したはずの障害を復活させる）。
  → **001 を適用するなら、`--only 001,012` で 001→012 を同一実行内で番号順に流し、最終状態を「4 引数版のみ」に
  収束させる。** 012 の SQL は `search_knowledge` の 3 引数版を DROP し 4 引数版を `create or replace` するため、
  001 が増設した 3 引数版を打ち消して 4 引数版へ揃う。012 は冪等（no-sentinel）なので同伴適用は安全。
  - ⚠ **台帳の実態（誤解しやすい点）**: 本番 `schema_migrations` に **012 は登録されていない**（012 は dry-run の
    pending 7 件に含まれる）。したがって bare `scripts/migrate.ts --apply` は **012 を skip せず自動適用する**
    （＝「012 は登録済みだから skip される」という理解は誤り）。ただし bare `--apply` は 001/012 以外の pending
    （`024 / 025` 等）まで巻き込むため、**001 の復旧では `--only 001,012` を使って対象を 001→012 の 2 件に限定する**。
    これにより「4 引数版のみ」への収束を、他 migration を巻き込まずに同一実行で達成できる。
- ⚠ **populated table への ivfflat index**: 本番 `knowledge_chunks` は投入済み。ivfflat index の作成は
  テーブルをロックしうるため、**`CREATE INDEX CONCURRENTLY` 相当・オフピーク実施を推奨**。
  ただし `CREATE INDEX CONCURRENTLY` は **トランザクション内で実行不可**なので、index 再作成は単独ステップとし、
  関数修復（001 末尾＋012・こちらは高速でトランザクション可）は別途まとめて流す。col 型 alter と index の
  再構築でロック/再構築時間が発生しうる点を織り込み、トラフィックの少ない時間帯に行う。
- 完走の受け入れ基準: (1) ivfflat index が存在、(2) `search_knowledge` は **4 引数版のみ**（3 引数版が残らない）、
  (3) 実クエリで PostgREST がオーバーロード解決に失敗しない。

#### 024 / 025（broadcast_stats / dormant_reengagement_log）— 機能有効化時のみ適用

- これらの SQL ヘッダは明示的に **「適用: 本番未適用」= 本番へ当てないことが設計**（024 = 配信計測の集計テーブル、
  025 = 休眠再訪「静かな一通」の意思決定台帳）。pending のまま残るのが正常。
- 適用するのは **stats / dormant 機能を本番で有効化する時だけ**（それぞれ fetch ジョブ / cron 配線を本番で回す判断とセット）。
  友だち数が LINE Insight のユニーク値 null 返却しきい値（20 人）を大きく超えるまでは有効化前提が整わない、
  という判断で保留している。
  （**友だち数をこのドキュメントに書かない**。友だち数は日々変わるので、書いた瞬間から古くなる。
  無料枠ガードの見積は **送信のたびの実測**（`src/lib/line-audience-size.ts` → `GET /v2/bot/followers/ids`）が正で、
  環境変数 `LINE_BROADCAST_ESTIMATED_RECIPIENTS_*` は **実測できなかったときのフォールバック専用**へ降格した
  〔2026-09-11〕。現在値を知りたいときは LINE を見る。）
- したがって「pending 解消」を目的に 024/025 を無条件適用しない。有効化判断が出たときに、当該機能の cron/フラグ投入と
  同時に `--apply` する（両テーブルとも `IF NOT EXISTS` で冪等）。
- **スクリプト側の担保**: `scripts/deploy-prod.sh` は `024 / 025 / 027` を**本番非適用リスト（deny-list）**として持つ。
  `MIGRATE_ONLY` に含めても `MIGRATE_DENYLIST_ACK=<version>` を明示しない限り中断する。
  「手順書では禁じているのにスクリプトが当ててしまう」状態を構造的に起こせなくするための二重ガード。

### デプロイ前ゲート — 「今から本番に載るコミット」の検証（scripts/deploy-preflight.sh）

**なぜ**: `wrangler deploy` は *今checkoutしている中身* をそのまま本番へ上げるだけで、それが
既定ブランチの最新かを一切見ない。実際に、ローカルmasterが `origin/master` より古いまま
`pnpm deploy` を撃ち、**すでに本番へ入っていた修正を巻き戻したビルド**を本番に載せかけた事故が起きた。

**どこで効くか**: 本番へ向かう2経路の両方が同じ1実装（`scripts/deploy-preflight.sh`）を通る。

| 経路 | ゲート |
|---|---|
| `pnpm deploy`（bare `wrangler deploy`） | 実行 |
| `scripts/deploy-prod.sh` / deploy-prod workflow | preflight STEP 1で実行 |
| `pnpm deploy:staging` | **対象外**（featureブランチからの検証デプロイが正常運用） |

**中止条件（どちらかに当たればexit 1・デプロイに進まない）**:

1. working treeがdirty（未コミット差分・**未追跡ファイル含む**） — **override不可**。
   何を本番に載せたか後から再現できないビルドを作らせないため。
2. `HEAD` のSHAが `origin/master` の最新と不一致（古い / 分岐している）。
   中止時はahead/behind数と「本番に載らなくなるコミット」の一覧を出す。

**override（緊急時のみ）**: `DEPLOY_ALLOW_NON_DEFAULT=1` を付けると2のみ警告付きで通る
（差分サマリはoverrideでも必ず表示される）。1は解除できない。

```bash
# 通常の直し方（override ではなくこちらが既定）
git fetch origin && git checkout master && git merge --ff-only origin/master

# どうしても今の HEAD を載せる必要があるとき（意図を明示）
DEPLOY_ALLOW_NON_DEFAULT=1 pnpm deploy
```

リグレッションテストは `tests/unit/deploy-preflight.test.ts`（`pnpm test:unit` に組み込み済み。
使い捨てのgitリポジトリをtempに作って通過/中止/overrideを実行検証する。本番には触らない）。

### Deploy Order

1. **Supabase migrations** (if any pending) — 初回は上記 baseline を先に通す。
2. **elxea-cx-agent**: `pnpm deploy`（本番フル反映は `scripts/deploy-prod.sh` / deploy-prod workflowが
   preflight → migration → deploy → health(+webhook検証) → version_skew_reportを一括実行）
   - migrationは**明示指定制**。`MIGRATE_ONLY` で当てるversionを名指しする（当てないなら `MIGRATE_ONLY=NONE`）。
     未指定は中断する（fail-closed）。workflowから回す場合は `migrate_only` 入力に同じ値を入れる。
     例: `CONFIRM=DEPLOY-PROD MIGRATE_ONLY=NONE SUPABASE_DB_PASSWORD=xxx ./scripts/deploy-prod.sh`
3. **elxea-web-app**: Vercel production deploy（merge to main の Git 連携自動デプロイ・**別レーン**）

### web-app は別レーン（版ずれは束ねず可視化する）

- cx-agent の本番反映（deploy-prod）は **web-app を発火しない**（Vercel Deploy Hook を足さない）。
  web-app は従来どおり main push の Git 連携で自動デプロイされる。
- 代わりに deploy-prod は**反映した cx-agent の git SHA を出力**する（`DEPLOYED_CX_AGENT_SHA=...`）。
  web-app 側 SHA（Vercel の `VERCEL_GIT_COMMIT_SHA` 等）を `WEB_APP_SHA=<sha>` で渡すと簡易 compare が出る
  （版ずれは消せないが**検知可能**にする）。
- **API 契約変更を跨ぐときは後方互換 1 リリースを挟む**（cx-agent の API 変更を先行リリースし、web-app が
  旧・新どちらでも動く 1 リリースを経てから web-app を切り替える）。両レーンの同時破壊的変更は避ける。

### Deploy Steps

```bash
# 1. Final staging verification
npx tsx scripts/verify-staging.ts

# 2. Deploy to production
#    ⚠ `pnpm deploy` はwranglerの前にscripts/deploy-preflight.shを通る（下記「デプロイ前ゲート」）。
pnpm deploy

# 3. Verify production (health check only, no Claude API calls)
curl -s https://elxea-agent.setaka-on.workers.dev/ | jq .
# Expected: {"status":"ok","service":"elxea-agent"}

# 4. Smoke test (manual)
# - Open https://www.elxea.com
# - Send a message via ChatBar
# - Verify SSE streaming response
# - Check Slack for any error alerts
```

### 段階昇格するとき（version を作ってから少しずつ載せる）

一括で載せず、先に version だけ作って一部トラフィックで様子を見る手順。
**`wrangler versions upload` を手打ちしない。** 手打ちすると version に tag が付かず、
Cloudflare 側のメタデータだけでは由来コミットを確定できない（2026-09-12 に実際に起きた。
ブランチ先端との振る舞い一致による間接確認で済ませるしかなかった）。

```bash
# 1. version を作る（--tag <短SHA> / --message <完全SHA + ブランチ + 件名> が自動で付く）
pnpm run upload:version
#    → 出力の Version ID を控える。tag から commit を引けるので、切り戻し先の中身が即分かる。

# 2. 一部トラフィックへ載せる（Tier 2: Setaka 承認が要る操作）
npx wrangler versions deploy <version-id>@<percent> <current-version-id>@<percent>

# 3. 実測を見て 100% へ昇格、または前 version へ戻す
```

刻印の実装は `scripts/upload-version.sh`（`scripts/deploy-worker.sh` と同じ
`scripts/lib/deploy-stamp.sh` を通る）。`tests/unit/deploy-worker-stamp.test.ts` が
「刻印を通さない `wrangler deploy` / `wrangler versions upload` がリポジトリに無いこと」を
機械で縛っている。

### Rollback

```bash
# Rollback to previous version
wrangler rollback

# Verify rollback
curl -s https://elxea-agent.setaka-on.workers.dev/ | jq .
```

## LINE配信の運用（送信条件 / env分離 / テスト配信）

> **2026-09-22 変更（段1-A）: 「全件送る口」を撤去し、送信は 1 件指定だけになった。**
>
> - 送信口は **`POST /api/delivery/send-one` のみ**。旧 `POST /api/delivery/run`（Approved を
>   全件走査して送る）と `runOnDemandDelivery` / `runDeliveryOnce` は **コードから削除**した
>   （互換残置なし。復活していないことは `tests/unit/cron-routing.test.ts` が機械検知する）。
>   「承認してから『配信して』と言う」旧方式はこの反映をもって終わり。
> - 送信までに通る関門: ① 配信DB行が Approved かつ未送信 → ② **All Tasks の判定行で承認確認**
>   （判定=承認 / 最終編集者 = `DELIVERY_OWNER_EMAIL`）→ ③ 指紋照合（**本文・画像・配信対象**）
>   → ④ 対象人数が承認時比 +10% 以内かつ台帳残枠内 → ⑤ claim-before-send（原子的に「送信中」を取る）
>   → ⑥ `X-Line-Retry-Key` 付きで送信（同一実行内で最大 2 回再試行）→ ⑦ **成功応答を確認してのみ Sent**。
>
> **2026-09-22 追加（段1-A2 / QA 指摘の是正 + Mac 側パイプライン契約）**
>
> - **「届いたのに Failed」をなくした**: LINE が 409 + `x-line-accepted-request-id` を返すのは
>   「その再試行キーの要求は既に受理済み」（= **届いている**）の意。これを成功として扱い、
>   request id にその値を採る。初回がタイムアウトして実は通っていた場合に必ずここを通る。
> - **multicast はバッチごとに再試行キーを変える**（LINE 仕様「同じ鍵で宛先を変えない」。
>   500 人を超えたときに後半が 409 で弾かれて届かない事故を塞ぐ）。決定性は維持。
> - **承認判定は実オプション名の完全一致 allowlist**（既定 `承認`）。「承認」で始まる別オプション
>   （例「承認前確認」）は通さない。差し替えは secret `DELIVERY_APPROVAL_JUDGMENTS`（カンマ区切り）1 か所。
> - **応答に `requestId` を追加**（送れたときだけ・それ以外は `null`）。
> - **残枠照会の口を新設**: `GET /api/delivery/ledger?pageId=&env=`（読み取り専用・副作用ゼロ）。
>   旧・全件走査の口の冒頭にあった**台帳の自動補正は再配線しない**（Boss 判断）。
>   代わりに **Mac 側の準備段が `POST /api/broadcast-recipients/reconcile` を叩いてから照会する**
>   （下記「送る前に残枠を照会する」）。送信 API の側は台帳を自動で直さない。
> - **`Status=Approved` は人が入れる欄ではなくなった**（承認の置き場は All Tasks の判定行 1 か所）。
>   誰かが手で Approved にしても、判定行の承認確認と指紋照合を通らない限り送られない。
> - **承認は 2 つの口に分かれた（2026-09-22 / 段1a-3・承認 1 点化）**。
>   - `POST /api/delivery/pin`（prepare 段）= 本文・画像・配信対象の**指紋を固定するだけ**。
>     画像は R2 に取り込んで凍結し、ハッシュを「コンテンツハッシュ」列に書く。
>     **Status は動かさない（Draft のまま）**＝人が承認する前に Approved の行を作らない。
>     受け付けるのは **`Status=Draft`（未承認）の行だけ**。Draft の間は誰も承認していないので
>     **再 pin は上書き可**だが、承認後（`Approved` / `Sending` / `Sent` / `Failed`）の行は
>     409 `pin_not_allowed_in_status` で拒否する（承認済みの内容と指紋を別々にさせない）。
>     承認後に内容を直したいときは **人が Status を Draft に戻してから** 1 からやり直す。
>   - `POST /api/delivery/approve`（reserve 段）= **All Tasks 判定行**（判定=承認 /
>     最終編集者のメール = `DELIVERY_OWNER_EMAIL`）を検証し、**pin 時の指紋と現在値が一致する**
>     ことを確かめてから **Status=Approved を機械が書く**。pin 後に本文・画像・配信対象が
>     変わっていたら承認しない（`content_changed_since_pin`）。
>   - **配信DB行の people 列「承認者」「担当者」は読まない**（列は残すが判定に使わない）。
>     旧 2 点承認（承認者 != 担当者）の門は、1 点化では誰も埋めない項目になり常時 fail に
>     なったため撤去した。`DELIVERY_ALLOW_SELF_APPROVAL_TEST` / `_PROD` も撤去（コードが
>     読まないため Cloudflare 側に残る同名 secret は無害）。
>   - 承認時の対象人数（`approvedAudienceCount`）と `audienceKey` は **応答で返すだけ**で
>     Notion には書かない（配信DBに「通数見積」「承認日時」列は存在せず、書くと Notion 400。
>     承認時刻の正本は判定行の `last_edited_time`）。
>   - **配信対象を含まない旧形式の pin は受け付けない**（旧 pin は全件送信経路の遺物・fail-closed）。
>
> **本番反映の前提（未設定だと必ず止まる）**
>
> | 前提 | 内容 | 未設定時の挙動 |
> |---|---|---|
> | secret `DELIVERY_OWNER_EMAIL` | 承認者の照合メール 1 件のみ（既定値なし・CIRCL 側のアドレス） | 全要求が `owner_email_unset` で拒否 |
> | migration **056** | `line_message_ledger` に `reservation_id` / `send_state` / `sent_count` | claim が列不在で失敗 → 送信しない |
> | secret `NOTION_APPROVAL_TOKEN`（2026-09-23 案B） | 承認確認**専用**の Notion 接続。権限は Read content + User information (with email) のみ。**All Tasks DB だけ**に共有する。配信DB用の `NOTION_TOKEN` とは別物で、未設定時に `NOTION_TOKEN` へ切り替えない | Notion を呼ばずに `approval_token_unset`（422・再試行しない） |
> | 承認用接続の **ユーザー情報の読み取り capability** | `GET /v1/users/<id>` の `person.email` が返ること。**段1-B の疎通確認項目** | メールが空 → `email_empty` で永久に停止（安全側だが原因が見えにくい） |
> | 承認用接続が **All Tasks に共有**されていること | 判定行（`判定` / `last_edited_by` / 親 DB / Details の `approval_key` / URL 列）を読む | 判定行が 404 → `task_not_shared`（422・再試行しない）。token 無効 401/403 → `approval_token_invalid`（422） |
> | 判定行の親と紐付け | 親が All Tasks（database `50adc342…` / data source `1c95f66a…`）で、Details の `approval_key=elxea-line-delivery:<env>:<配信行 id>`（と URL 列があればその id）が要求の `pageId` と一致 | `task_parent_mismatch` / `task_link_mismatch`（422） |
>
> 応答（同期 JSON）: `{ status, code, reason, sentCount, audienceCount, ledgerRemaining, reservationId, targetEnv }`
> / `200` = 送った（同一 `reservationId` の二重到達も再送せず 200）/ `409` = 既に送信中・送信済
> / `422` = 承認・指紋・人数の確認で拒否 / `503` = 一時失敗（保留・再試行可）/ `502` = 送信失敗。

> **この節はコマンドの正本**。運用者向けの平易な手順は `docs/line-delivery-guide.md`（およびNotion版
> <https://app.notion.com/p/39970c9d064c81dabf04f65c073d667c>）をSoTとし、本節は「エンジニア作業の実行手順」を持つ。
> 片方だけを直さない（配信まわりのコード変更時は両方を更新する）。

### 現状（2026-08-22・2026-09-22・2026-09-25更新 / それ以外の行は2026-07-27時点）

| 項目 | 状態 | 根拠 |
|---|---|---|
| **配信の起動方法** | **1 件指定のオンデマンドのみ（2026-09-22 / 段1-A）**。cronの自動配信は**廃止**、全件走査の口も**撤去**。`POST /api/delivery/send-one` に `pageId` を渡したときだけ、**その 1 行だけ**が送られる | Setaka指示（「承認済みが勝手に飛ぶより、回したときに送るほうが安全」）。`wrangler.toml` のcronsに配信パターンなし + `src/index.ts` のdelivery分岐はno-op（`tests/unit/cron-routing.test.ts` が両方を機械検知） |
| **配信予定日時** | **送信条件ではない**。運用者の記録用メモとして残るだけ（空でも構わない） | 送信判定（`sendOneDelivery()`・`delivery-send-one.ts`）はこの値を一切参照しない（`delivery-time.ts` ごと削除済み） |
| 実送信スイッチ `DELIVERY_SEND_ENABLED` | **撤去済み（2026-08-22）**。staging・本番のどちらにも存在しない。`send-one` で指定され関門を通った行は**常に実送信される**。送信の開閉は配信本体の外、Mac 側の送信パイプラインが読む Notion「LINE配信スイッチ」で行う（`docs/line-delivery-guide.md`「送信を止める・再開する（配信スイッチと緊急停止）」） | Setaka指示（承認済み配信がスイッチOFFで3時間以上遅延した事故を受けて関門を削減）。コード上の参照ゼロ（`tests/unit/golive-broadcast-wiring.test.ts` が再導入を機械検知） |
| **承認の権威** | **All Tasks の判定行 1 か所（2026-09-22 / 承認 1 点化）**。配信DB行の people 列「承認者」「担当者」は**読まない** | `delivery-approve.ts`（`approveDelivery`）+ `delivery-approval-task.ts`（`verifyApprovalTask`）。旧 `delivery-approval.ts`（`isApprovalAuthorized` / `selfApprovalRelaxed`）と `DELIVERY_ALLOW_SELF_APPROVAL_*` は**削除済み**（Boss 判断 Tier 1・段1 結合検証 I-C）。旧決定記録 <https://app.notion.com/p/3a870c9d064c81f986ddc7a8b805d6af> は本件で置き換え |
| Status=Approved を書くのは誰か | **機械のみ**（判定行の承認と指紋一致を確認した `POST /api/delivery/approve` だけ） | `markApproved()`（`delivery-repository.ts`）。pin 経路（`pinContentSnapshot()`）は Status を書かない |
| 配信 DB の env 分離 | **本番反映済み**（fail-closed） | `resolveDeliveryDbId()`（`delivery-repository.ts`） |
| staging 実配信の実証 | **済**（写真2枚・4/4 成功 2026-07-27） | 証跡行 <https://app.notion.com/p/3a970c9d064c8184a005cf763f2331af> |
| **全員配信の受信者数** | **送信のたびに LINE から実測（2026-09-11）**。env 固定値は**フォールバック専用**へ降格 | `line-audience-size.ts`（`GET /v2/bot/followers/ids`・ページング + 安全弁・userId は数えるだけで保持しない）。実測不能時のみ `LINE_BROADCAST_ESTIMATED_RECIPIENTS_*` を使い、**どちらを使ったかはログの `[delivery] friend-count basis=` に出る**。実測も env も無ければ従来どおり fail-closed（送信不可） |
| **送信後の台帳補正** | **手動トリガのみ（2026-09-22 訂正）**。送信時に控えた `X-Line-Request-Id` を鍵に実配信数で `line_message_ledger.recipients` を直す。**送信 API の側では自動実行しない** | `broadcast-reconcile.ts`（`GET /v2/bot/insight/message/event?requestId=` の `overview.delivered`）。口は `POST /api/broadcast-recipients/reconcile` **のみ**。旧・全件走査の口の冒頭にあった自動補正は、その口ごと撤去された（段1-A）。**呼ぶのは Mac 側パイプラインの準備段の責務**（下記「送る前に残枠を照会する」）。**GET のみ・送信系 API 非接触**。LINE の統計は**送信から 14 日**で消えるため、それを過ぎた行は見積のまま残す。要 migration 055 |

#### ⚠ 最重要の運用ルール: 送られるのは「指定した 1 行」だけ

**2026-09-22（段1-A）に「全件送る口」を撤去した。** 以後、配信が走るのは
**`POST /api/delivery/send-one` の body に `pageId` を書いて叩いた瞬間だけ**で、
送られるのは **その 1 行だけ**である。時刻が来ても、承認しただけでも、何も起きない。
他の行が一緒に飛ぶことは構造的に起こらない（配信 DB を走査するコードが存在しない）。

その 1 行が送られるには、次を **すべて** 満たす必要がある（`sendOneDelivery()` の順序。
1 つでも満たさなければ送らずに理由を返す = fail-closed）:

1. 配信 DB 行が `Status=Approved` かつ `送信済み=false`（`Sending` は二重送信防止で受け付けない）
2. **All Tasks の判定行で承認が確認できる** — 判定が承認 allowlist に一致（既定 `承認`・完全一致）
   かつ最終編集者のメールが `DELIVERY_OWNER_EMAIL` と一致
3. **指紋が承認時と一致**（本文・画像・**配信対象**の 3 点。承認後にどれかを変えると不一致で止まる）
4. 対象人数が承認時から **+10% 以内**、かつ当月の**無料枠の残りに収まる**
5. **claim-before-send に成功**（同一 `notion_page_id` × 月の二重送信を DB の排他で拒否）
6. `X-Line-Retry-Key` 付きで送信（同一実行内で最大 2 回再試行・鍵は予約 ID から決定的）
7. **成功応答を確認してのみ `Sent`**（LINE が「その鍵は既に受理済み」= 409 を返した場合も
   **届いているので `Sent`**。この場合の request id は `x-line-accepted-request-id` を採る）

> **運用ルール（守ること）**: 叩く前に **body の `pageId` が送りたい行の id であること**を確認する。
> 確認すべきは「Approved の一覧」ではなく **その 1 つの id** である（一覧に何が写っていても飛ばない）。
> 練習は必ず **staging + テスト用DB + テストOA（@426vlcyb）** で行う（後述「テスト配信の手順」）。

#### 送る前に残枠を照会する（`GET /api/delivery/ledger`）

**送信 API は台帳を自動で直さない。** 旧・全件走査の口の冒頭にあった台帳の自動補正は、
その口ごと撤去された（段1-A）。**代わりに、送る前に次の 2 つをこの順で叩く**
（Mac 側パイプラインの準備段がこれを行う。手で送るときも同じ順序でやる）:

```bash
BASE=https://elxea-agent-staging.setaka-on.workers.dev   # 本番は https://elxea-agent.setaka-on.workers.dev
SECRET=$SYNC_API_SECRET_STAGING                          # 本番は $SYNC_API_SECRET
PAGE_ID=<配信DBの行 id>

# 1. 台帳の後追い補正（見積で建てた通数を実数へ直す・GET のみ・送信系 API 非接触）
curl -sS -X POST "$BASE/api/broadcast-recipients/reconcile" \
  -H "Authorization: Bearer $SECRET" | jq .

# 2. 残枠と対象人数の照会（読み取り専用・副作用ゼロ）
curl -sS "$BASE/api/delivery/ledger?pageId=$PAGE_ID&env=staging" \
  -H "Authorization: Bearer $SECRET" | jq .
```

補正（1）を先に叩く理由: 残枠の主判定は台帳の確定消費なので、見積のまま膨らんだ行が残っていると
**残枠を実際より少なく見て送信が止まる**。補正してから照会すると、残枠が実態に一致する。

照会（2）の応答:

```json
{
  "ok": true,
  "monthKey": "2026-09",
  "freeTierCap": 200,
  "headroom": 10,
  "ledgerRemaining": 150,
  "audienceCount": 79,
  "audience": "全員",
  "targetEnv": "test"
}
```

- `ok` が `false` なら **送ってはいけない**（残枠か対象人数のどちらかが取れていない）。理由は `reason`。
- 実効上限は `freeTierCap - headroom`（= 190 通/月）。`audienceCount > ledgerRemaining` なら送信は
  `ledger_exhausted` で止まる。**照会の段階で分かるので、叩く前に気づける。**
- `env` は **呼び出し側の思い込みと実物の突合せ**に使う（`prod` / `staging`。`staging` は `test` の別名）。
  この Worker の送信先と食い違うと **400 で弾かれる**（staging の残枠を本番のものと取り違える事故を塞ぐ）。
- 副作用ゼロ。配信 DB にも台帳にも書かず、Status も動かさない。外部 I/O は読み取りのみ。

#### 承認の順序（prepare=pin → 人の承認 → reserve=approve → 送信=send-one）

この 4 手をこの順にしか通せない。順序そのものが安全装置である（2026-09-22 / 承認 1 点化）。

| # | 手 | 誰が | 口 | 何が起きるか |
|---|---|---|---|---|
| 1 | prepare（pin） | 機械（Mac 側パイプライン） | `POST /api/delivery/pin` | 本文・画像・配信対象の指紋を固定。画像を R2 に凍結。**Status は Draft のまま** |
| 2 | 承認 | **Setaka（人）** | All Tasks の判定行の「判定」を `承認` にする | 承認の意思はここ 1 か所にしか置かない（配信DB行は触らない） |
| 3 | reserve（approve） | 機械 | `POST /api/delivery/approve` | 判定行を検証 + 指紋一致を確認 → **Status=Approved を機械が書く** |
| 4 | 送信 | 機械 | `POST /api/delivery/send-one` | Status=Approved + 指紋 + 判定行を**もう一度**確認してから送る（第二の防御） |

```bash
# 1. prepare: 指紋を固定する（Status は変わらない。実送信なし）
curl -sS -X POST https://elxea-agent-staging.setaka-on.workers.dev/api/delivery/pin \
  -H "Authorization: Bearer $SYNC_API_SECRET_STAGING" \
  -H "Content-Type: application/json" \
  -d '{"pageId":"<配信DBの行 id>"}' | jq .
# → {"status":"pinned","contentHash":"...","approvedAudienceCount":4,"audienceKey":"allowlist"}

# 3. reserve: 判定行の承認を確認して Status=Approved にする（実送信なし）
curl -sS -X POST https://elxea-agent-staging.setaka-on.workers.dev/api/delivery/approve \
  -H "Authorization: Bearer $SYNC_API_SECRET_STAGING" \
  -H "Content-Type: application/json" \
  -d '{"pageId":"<配信DBの行 id>","approvalRef":{"taskPageId":"<All Tasks 判定行 id>","approvedEditorEmail":"<承認を観測した時点の最終編集者メール>","approvedEditedTime":"<同時点の last_edited_time>"}}' | jq .
# → {"status":"approved","pinned":true,"approvedAudienceCount":4,"audienceKey":"allowlist","contentHash":"..."}
```

止まったときの読み方（`code` を見る）:

| code | HTTP | 意味 | 次の手 |
|---|---|---|---|
| `pin_missing` | 422 | prepare（pin）を通っていない | 1 からやり直す |
| `judgment_not_approved` | 422 | 判定行が承認になっていない | 人の承認を待つ |
| `editor_mismatch` | 422 | 判定行の最終編集者が承認者本人ではない | 承認者本人が判定行を編集し直す |
| `content_changed_since_pin` | 422 | pin 後に本文・画像・配信対象が変わった | 内容を確定させて 1 からやり直す |
| `owner_email_unset` | 422 | secret `DELIVERY_OWNER_EMAIL` が未設定 | secret を入れる（照合先が無いと全拒否） |
| `email_lookup_retryable` / `task_fetch_retryable` / `audience_unresolved` | 503 | 一時失敗（Notion 429/5xx・人数を数えられない） | そのまま再試行してよい（何も書いていない） |
| `row_already_sent` / `row_sending` | 409 | 既に送信済み・送信中 | 触らない |
| `pin_not_allowed_in_status` | 409 | 承認後の行（`Approved` / `Sending` / `Sent` / `Failed`）に pin をやり直そうとした | 内容を直すなら人が Status を `Draft` に戻してから 1 からやり直す（承認も取り直す） |

#### 1 件指定送信のしかた（唯一の配信起動経路）

`SYNC_API_SECRET` によるBearer認証必須（未設定・不一致は401でfail-closed）。
**結果は同期で返る**（回したのに送られたか分からない状態を作らない）。

```bash
# --- staging（テストOA @426vlcyb 宛て・練習はこちら）---
curl -sS -X POST https://elxea-agent-staging.setaka-on.workers.dev/api/delivery/send-one \
  -H "Authorization: Bearer $SYNC_API_SECRET_STAGING" \
  -H "Content-Type: application/json" \
  -d '{"pageId":"<配信DBの行 id>","reservationId":"<予約 ID>","approvalRef":{"taskPageId":"<All Tasks 判定行 id>","approvedEditorEmail":"<承認者のメール>","approvedEditedTime":"<承認観測時の last_edited_time>","approvedAudienceCount":<承認時の対象人数>}}' | jq .

# --- 本番（実顧客OA @307tzhkw 宛て・Tier 2 = Setaka承認が必要）---
curl -sS -X POST https://elxea-agent.setaka-on.workers.dev/api/delivery/send-one \
  -H "Authorization: Bearer $SYNC_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"pageId":"<配信DBの行 id>","reservationId":"<予約 ID>","approvalRef":{"taskPageId":"<All Tasks 判定行 id>","approvedEditorEmail":"<承認者のメール>","approvedEditedTime":"<承認観測時の last_edited_time>","approvedAudienceCount":<承認時の対象人数>}}' | jq .
```

`approvalRef` の 4 つの値は **`POST /api/delivery/approve` の応答と判定行から取る**
（`approvedAudienceCount` は approve の応答、`taskPageId` / `approvedEditorEmail` /
`approvedEditedTime` は Mac 側の承認監視が「判定=承認を初めて観測した時点」で固定した値）。
手で組み立てるものではない。
`reservationId` は 1 回の送信意図につき 1 つ。同じ値で再度叩いても **再送されない**（冪等）。

レスポンス例（`targetEnv` で送信先OAを、`status` / `sentCount` で実績を確認する）:

```json
{
  "status": "sent",
  "code": "sent",
  "reason": "Sent: 実送信 79/79（1 回試行）",
  "sentCount": 79,
  "audienceCount": 79,
  "ledgerRemaining": 150,
  "reservationId": "<予約 ID>",
  "requestId": "<X-Line-Request-Id>",
  "targetEnv": "test"
}
```

- `status` / `code` が結果。`sent` 以外は 1 通も出ていない（`sentCount` も 0）。
- `requestId` は **送れたときだけ入る**（それ以外は `null`）。送信 1 回を指す鍵で、
  後から実配信数を引くのに使う。**この場で受け取らないと二度と手に入らない**
  （LINE の統計は送信から 14 日で消える）。multicast と冪等応答は鍵が定まらないため `null`。
- `reason` に「受理済み」と出たら、**前回の呼び出しが既に届いていた**という意味
  （409 + `x-line-accepted-request-id`）。重複送信は起きていない。
- **`targetEnv` が `prod` のレスポンスは実顧客に届いたことを意味する。** 練習時は必ず `test` を確認する。
- HTTP: `200` = 送った（同一 `reservationId` の二重到達も再送せず 200）/ `400` = 要求不正 /
  `409` = 既に送信中・送信済 / `422` = 承認・指紋・人数の確認で拒否 /
  `502` = 送信失敗 / `503` = 一時失敗（保留・再試行可）。

##### 実際に送られたかを確認する方法（すべて読み取りのみ）

0. **実行時のレスポンスを読む**（いちばん速い）: 上の `POST /api/delivery/send-one` は結果を同期で返す。
   `status` / `sentCount` がその実行の結果。`code` に止まった理由が入る。
1. **配信DBを見る**: 実行後に `Sent` / `送信済み=true` になっていれば送信済み。
   `Failed` / `PartialFail` なら `エラー詳細` を読む。`Approved` のまま残っている場合は
   上の関門 1〜5 のいずれかで止まっている（`エラー詳細` 欄かログを見る）。
2. **通数台帳を見る**: `line_message_ledger` の当月行の `recipients` の増分が実送信通数。
   送信後に `POST /api/broadcast-recipients/reconcile` を叩くと実数へ直る。
3. **Workerログを読む**（読み取り専用・実行と並行して流す）:

```bash
# 本番 Worker のログを追う（--env を付けない = 本番 elxea-agent）。読み取り専用。
pnpm exec wrangler tail --format pretty
# send-one を叩いたときだけ次の 1 行が出る（env ラベルで対象 OA も同時に確認できる）:
#   [delivery] send-one env=prod(@307tzhkw) month=2026-09 page=<id> reservation=<id> \
#     status=sent code=sent sent=79 audience=79 remaining=150
# status / sent が実送信の実績。status が sent 以外なら code に理由が入る。
# 全員配信の人数の出所は別行に出る:
#   [delivery] friend-count basis=measured count=79 pages=1
#
# ⚠ send-one を叩いていないのに [delivery] send-one 行が出たら異常。
#   併せて次の警告が出ていないか確認する（cron に配信パターンが残っている印）:
#   [delivery] cron tick ignored: 一斉配信はオンデマンド専用（POST /api/delivery/send-one）。
```

出力箇所は `src/lib/delivery-runtime.ts` の `console.log("[delivery] send-one ...")`、
ラベル `prod(@307tzhkw)` / `test(@426vlcyb)` は `src/lib/delivery-channel.ts` が組み立てる。

> **本番secretを調査目的で触らない**: 本番secretへの `put` / `delete` は事故（誤削除・誤投入）
> そのものを生む。状態を知りたいだけのときは**必ず上記の読み取りのみの方法**を使う。
> なおCloudflare側に残っている旧 `DELIVERY_SEND_ENABLED` secretは**無害**（コードが読まない）。
> 掃除したい場合のみ `pnpm exec wrangler secret delete DELIVERY_SEND_ENABLED`（挙動は変わらない）。

### ⚠ 禁止事項: 本番 Worker に `NOTION_DELIVERY_DB_ID` を設定しない

`resolveDeliveryDbId(env)` は **prod のとき明示 `NOTION_DELIVERY_DB_ID` を最優先する**
（未設定時のみ `PROD_DELIVERY_DB_ID` へ既定フォールバック）。したがって本番 Worker にこの変数を入れると、
**本番 Worker が指定された任意の DB（＝テスト用 DB）を読みに行く**経路が生まれる。
テスト用 DB の行が本番 OA（@307tzhkw・実顧客）へ配信されうるため、**設定してはならない**。

- 本番（`elxea-agent`）: `NOTION_DELIVERY_DB_ID` は **未設定のまま**にする（既定 = 本番配信 DB）。
- 検証（`elxea-agent-staging`）: **設定必須**。未設定は `DeliveryDbConfigError` で fail-closed（本番 DB へ落ちない）。
  本番 DB ID を入れた場合も throw する（逆方向の cross-env も塞がれている）。
- 誤設定の検知: `pnpm exec wrangler secret list`（本番）に `NOTION_DELIVERY_DB_ID` が出たら**即削除**する。

  ```bash
  pnpm exec wrangler secret list | grep NOTION_DELIVERY_DB_ID   # 本番: ヒットしないのが正
  pnpm exec wrangler secret delete NOTION_DELIVERY_DB_ID        # 誤って入っていた場合のみ
  ```

### 受信者数はどこから来るか（`LINE_BROADCAST_ESTIMATED_RECIPIENTS_*` の位置づけ）

**全員配信の「全員」は、常に送信したその瞬間の友だち全員である。**
`POST /v2/bot/message/broadcast` は宛先を指定せずに送るので、こちらが持っている数字は
実際の到達に一切影響しない。影響するのは「無料枠(200通/月)をどう見積もるか」＝帳簿だけ。

だから数字の出どころは次の優先順で決まる（`src/lib/line-audience-size.ts`）:

1. **実測**（正）: 送信の直前に `GET /v2/bot/followers/ids` を数える。ブロック済みは含まれないので
   broadcast の実到達に対応する。ページングあり・安全弁あり・**userId は数に潰して保持しない**。
2. **env フォールバック**: 実測が失敗したとき（429 / ネットワーク断 等）のみ
   `LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD` / `_TEST` を使う。
   **実測の失敗を理由に配信は止めない**（帳簿の数字のために配信を止めるのは本末転倒）。
3. **どちらも無い → 送らない**（fail-closed。従来どおり `resolveTargets` が `kind:"error"` を返す）。

送信後は `POST /api/broadcast-recipients/reconcile` を叩いたときだけ、LINE が数えた**実配信数**で台帳を直す
（送信 API の側では自動で直さない。Mac 側パイプラインの準備段が送る前に叩く。上の「送る前に残枠を照会する」）。

> **なぜこうしたか（2026-09-11・オーナー判断）**: env 固定値(48)を 2 ヶ月放置した結果、
> 台帳が実態より過少になっていた（08-05 台帳48/実測56・08-22 台帳48/実測63・09-11 台帳48/実測68）。
> 無料枠を守るための台帳が、守る対象の数字を取り違えていた。
> 「全員配信の『全員』は常にその時点の全員。固定値を持つこと自体が間違い」。
> → **この値を secret に入れ直して運用する運用は採らない**。env はもう正本ではない。

### 配信を止める

**大前提: `POST /api/delivery/send-one` に 1 行を指定して叩かなければ何も送られない。** 配信本体に
「放っておいたら飛ぶ」経路は存在しない。ふだんの送信は、Mac 側の送信パイプライン（見張り役が予約の時刻に起動）が
承認済みの 1 行ずつ send-one を叩く。以下はその流れを止めるときの操作（スタッフ・Setaka 向けの手順の正本は
`docs/line-delivery-guide.md`「送信を止める・再開する（配信スイッチと緊急停止）」）。

| 目的 | 操作 |
|---|---|
| **1件を止める** | All Tasks の判定行の「判定」を承認以外に戻す（send-one が `judgment_not_approved` で止まる）。念のため配信DB行の **Status を Approved → Draft** に戻してもよい（Approved は機械しか書かないので、戻した行は依頼・承認から取り直し） |
| **その環境の送信を全部止める** | Notion「LINE配信スイッチ」のその環境の行（`prod` / `staging`）を「閉」にする（Mac 側の送信パイプラインが send-one を叩かなくなる） |

- **send-one 実行中の行は間に合わない**。実行は数秒で終わるため、走り出したら止められない。
- **送信済みは取り消せない**。訂正はお詫び・訂正配信を新規作成 → 依頼 → 承認で行う。

### 本番デプロイ前の確認（配信コードを変更したとき）

**デプロイそのものでは配信は起きない**（cronの自動配信が無いため）。デプロイ直後に勝手に飛ぶ心配はない。
ただし Mac 側の見張り役は、承認済みの予約の時刻が来れば send-one を叩く。デプロイ後に何が飛びうるかを知るため、
**本番配信DBのApproved行を必ず確認する**（`f95bb981-3c1a-4b6e-abd2-8b39551f6492` をStatus=Approvedで絞り込む。
Approved で未送信の行 = 承認済みで予約の時刻を待っている行。予約の一覧は `~/.claude/progress/line-delivery/reservations/`）。

- 送るつもりのない行は、判定行の「判定」を承認以外に戻す（上の「配信を止める」）。
- 参照ビューは **「Default view」**（「かんたん配信（運用者用）」は `送信済み` を表示しない）。

### テスト配信の手順（検証環境・お客さまに届かない）

> **`--env staging` を必ず付ける。付け忘れたコマンドは本番 Worker（実顧客 OA）への操作になる。**

> **⚠ stagingも send-one が叩かれれば実送信になる（2026-08-22〜）。** 届く先がテストOA（@426vlcyb）なだけで、
> 送信そのものは本番と同じに起きる。逆に、**待っていても送られない**（cronの自動配信は無い）。
> ふだんの検証は本番と同じ入口（Slack の依頼 → 判定行の承認 → Mac 側の送信パイプライン、env=staging）で通す。

1. **テスト用DBに行を作る**: 「[TEST] 配信コンテンツ (staging/@426vlcyb)」
   （<https://app.notion.com/p/3a970c9d064c816aaf11cf790334957a>）に本番と同じ手順で作る。
   **Status は Draft のまま**（Approved は人が入れない。approve の口が機械で書く）。本番「配信コンテンツ」には**作らない**。
2. **依頼して承認する**: env=staging に対応する Slack の依頼チャンネルに依頼する（どのチャンネルをどの環境で受けるかは
   `~/.config/admin-pipeline/config/elxea-supply-intake.json` の `entries` が正本）→ All Tasks に判定行ができる →
   Setaka が「判定」を承認にする。Notion「LINE配信スイッチ」の `staging` 行が「開」でなければ送られない。
3. **実機確認**（テストOA @426vlcyb）。写真の順序・改行・文字化けを目視する。
   Notion側の書き戻し（Status=Sent / 送信結果 / 消費実績 / sent_at）も確認する。
4. 手で send-one を叩いて確かめるときは、上の「1 件指定送信のしかた」の staging 側コマンドを使い、
   レスポンスの `targetEnv` が `test` であることを必ず確認する。
5. **検証をやめるときは、承認済みの予約を残さない**（残すと予約の時刻に見張り役が送る）。判定行の「判定」を承認以外に戻すか、
   送信済み（Sent）まで完走させる。

### staging に必要な設定（テスト配信の前提）

`[env.staging.vars]` にある `DELIVERY_TARGET_ENV = "test"` に加え、以下を投入する（値はコミットしない）。

```bash
# 1. 配信 DB（テスト用・必須。未設定は fail-closed で staging が配信を実行できない）
#    値 = [TEST] 配信コンテンツ の database_id: 3a970c9d-064c-816a-af11-cf790334957a
pnpm exec wrangler secret put NOTION_DELIVERY_DB_ID --env staging

# 2. broadcast の想定受信者数（未設定/不正は target-resolver が fail-closed で停止）
#    値 = テスト OA のスタッフ人数（実測 4）
pnpm exec wrangler secret put LINE_BROADCAST_ESTIMATED_RECIPIENTS_TEST --env staging

# 3. R2（画像つき配信で必須。画像 put は承認 pin 時に行われる）
pnpm exec wrangler secret put R2_API_TOKEN  --env staging   # Workers R2 Storage: Edit 権限
pnpm exec wrangler secret put R2_ACCOUNT_ID --env staging   # 未設定は resolveR2Config が throw
# 任意（未設定時は既定にフォールバック）: R2_BUCKET_NAME（既定 elxea-images）/ R2_PUBLIC_BASE
```

投入後に名前だけ確認する（値は表示されない）:

```bash
pnpm exec wrangler secret list --env staging
```

- 本番 OA のトークンを staging に入れない（staging は `LINE_CHANNEL_ACCESS_TOKEN_TEST` を選択する）。
- `NOTION_DELIVERY_DB_ID` に**本番 DB ID を入れない**（`DeliveryDbConfigError` で fail-closed になる）。

### 緊急停止・ロールバック

| 目的 | 操作 | 効果 |
|---|---|---|
| すべて止める（本番・staging共通） | **`POST /api/delivery/send-one` を叩かない（1 件指定しかないので、指定しなければ何も送られない）** | 完全オンデマンド化（2026-08-22）により、これだけで新規送信はゼロ。cronの自動配信は存在しない |
| その環境の送信を止める | Notion「LINE配信スイッチ」のその環境の行（`prod` / `staging`）を「閉」にする | Mac 側の送信パイプラインが send-one を叩かなくなる（手順の正本は `docs/line-delivery-guide.md`「送信を止める・再開する（配信スイッチと緊急停止）」） |
| 特定1件を止める | NotionでStatusを **Approved → Draft** | send-one が叩かれる前なら確実に止まる（Status の門）。send-one 実行中は間に合わない可能性あり。戻した行は依頼・承認から取り直し（Approved は機械しか書かない） |
| 念のため全行を無効化 | 対象の行のStatusを **Approved → Draft**（複数件なら1件ずつ） | send-one は Approved の行しか送らない。Approved がゼロなら send-one が叩かれても何も出ない |
| 承認を取り消す | All Tasks 判定行の「判定」を承認以外に戻す（さらに念のため配信DB行を Approved → Draft） | 判定行が承認でなければ send-one は `judgment_not_approved` で止まる（第二の防御）。配信DB行の Status も第一の門として効く |
| 画像つき配信を止める | `pnpm exec wrangler secret delete R2_API_TOKEN` | 画像つき行の承認 pin が fail-closed（テキストのみ配信は継続） |
| roji最初のアンケートを止める | `pnpm exec wrangler secret delete ROJI_SURVEY_ENABLED`（または `printf 'false' \| pnpm exec wrangler secret put ROJI_SURVEY_ENABLED`） | アンケートが一切起動しなくなる（合言葉もボタンも無反応・器にも書かない）。詳細は下記「roji最初のアンケートの停止スイッチ」 |
| コードごと戻す | `wrangler rollback` | 直前バージョンへ（secret は消えない・`keep_vars = true`） |

**送信済みは取り消せない**。訂正はお詫び・訂正配信を新規作成 → 承認で行う。

### 残存リスク（承認 1 点化の明示）

- **per-配信の人間ゲートは 1 点**である。配信ごとの人的チェックは **All Tasks 判定行の
  「判定」を承認にする、その一操作**のみ（2026-09-22 の承認 1 点化。従来の「著者 != 承認者」の
  二人目の確認は、1 点化で誰も埋めない項目になったため撤去した）。
  2026-08-22 に実送信スイッチ（送信直前の Tier 2 ゲート）も撤去しているため、配信ごとの人的ゲートは承認のみ
  （Notion「LINE配信スイッチ」は環境ごとの開閉で、配信ごとの確認ではない）。
  残る自動ゲートは形式検査（判定行の最終編集者 = `DELIVERY_OWNER_EMAIL` / 指紋一致 /
  対象人数 +10% / 画像形式・サイズ / 無料枠台帳 / claim による二重送信防止）であり、
  **内容の妥当性・宛先の妥当性は検査されない**。
- したがって **All Tasks 判定行の編集権限と Notion「配信コンテンツ」の書き込み権限が、
  実質的な配信統制そのもの**になる。どちらかの編集権限を持つ人を増やすことは
  「本番配信を単独で実行できる人を増やす」ことと等価として扱う。
- 判定行の `last_edited_by` は**ページ全体で 1 人**しか持てないため、承認以外の編集
  （コメント欄の更新等）でも最終編集者は動く。承認の観測時点を固定するのは Mac 側の
  承認監視であり、配信本体はその固定値を突き合わせる**第二の防御**にとどまる。

## roji最初のアンケートの停止スイッチ（`ROJI_SURVEY_ENABLED`）

roji最初のアンケート（6問・全部1タップ）を、**巻き戻し（rollback）なしで止められる**ようにするスイッチ。
配信（Notion駆動の一斉配信）とは**完全に独立**（アンケートは返信のみで、
push / broadcast / multicastを一切呼ばない）。

| 項目 | 内容 |
|---|---|
| 名前 | `ROJI_SURVEY_ENABLED`（Cloudflare Workers Secret） |
| ONの条件 | 値が **`"true"` の完全一致**のときだけ。`"TRUE"` / `"1"` / `"yes"` / 前後に空白 は**すべてOFF** |
| 未設定のとき | **OFF**（fail-closed）。secretを消す・空にする＝止まる |
| 判定の正本 | `src/lib/roji-survey.ts` の `isRojiSurveyEnabled()`。参照点は `roji-survey-handler.ts` の `handleRojiSurvey` 入口 **1か所のみ** |
| 切り替えにデプロイ | **不要**。secretを書き換えれば次のリクエストから効く |

### OFFのとき何が起きるか

- 合言葉（`rojiをつくっています`）を打っても始まらない
- 内部トークン（`roji｜…`・ボタンのpostback）を送っても反応しない（1通も返さない）
- 自由文も横取りしない（「ひとこと待ち」の人でも既存の会話へ素通りする）
- 器（`flow_events` / カルテ / `roji_words`）に**1行も書かない**
- **この機能を入れる前（master）と同じ挙動に戻る**（postbackはroji導入前もどこでも扱っていなかった）

### 途中まで答えた人がOFFになったら

**その人も即時停止する**（「進行中だけ続きを通す」抜け道は作っていない）。理由は
「OFFならmasterと同じ挙動」を例外なく満たすため。
**答えは失われない** — アンケートは1問ごとに独立して器へ書くため、OFFの時点までの答えは残る。
再びONにすると状態は出来事の置き場から読み直され、**やり直しではなく「答えていない問い」から再開**する。

### 値の確認について

Cloudflareのsecretは**本番の値を読み出せない**（`wrangler secret list` は名前のみ）。
「今ONかOFFか」を文書側で断定しない。挙動で確かめる（OFFなら合言葉に無反応）。

> このスイッチを追加した工程（2026-08-08）では、**本番にもstagingにもsecretを登録していない**
> （コードとテストのみ）。登録は公開工程で別途行う。
> したがって「今どちらに何が入っているか」は、この節からは断定できない（上の「値の確認について」に従う）。
>
> **更新（2026-08-08第3工程・再実行）**: コードは本番へ配布済み（HEAD `abbe862`）だが、
> `ROJI_SURVEY_ENABLED` は**引き続き未登録**（`wrangler secret list` の名前一覧に無いことを配布後に確認）。
> よって**アンケートは本番でOFF**であり、メニュー未差し替えと合わせて二重に到達不可のまま。
>
> **更新（2026-08-08第4工程・公開）**: `ROJI_SURVEY_ENABLED` を**本番に `"true"` で登録した＝ON**。
> secret数28 → 29。**ただしリッチメニューは差し替えていない**ため、お客さんの画面に入口は無い。
> 到達経路は合言葉 `rojiをつくっています` の完全一致と `roji｜*` のpostbackのみで、
> どちらも**お客さんが知りうる場所に出していない**。詳細は「本番反映の実施記録」の第4工程を参照。
>
> **更新（2026-08-09・安全措置）**: 既存の「好み診断」との重複を調べている最中で**公開の要否が未判定**のため、判定が出るまでの安全措置として `ROJI_SURVEY_ENABLED` を**本番から削除した＝OFF**（secret数29 → 28・名前一覧から消えたことを確認・デプロイ不要・他のsecretは触っていない・データは前後で不変）。
>
> **更新（2026-08-10・公開＝ON。Setaka承認「全部進めてください」）**: `ROJI_SURVEY_ENABLED` を
> **本番へ `"true"` で明示的に投入した＝ON**（`printf 'true' | pnpm exec wrangler secret put ROJI_SURVEY_ENABLED`）。
> 投入前から名前一覧に同名secretが載っていた（prod secret数は投入の前後どちらも29）ため、
> **値は読めない前提に立って上書きした**（この節の「値の確認について」に従い、文書側で旧値を断定しない）。
> あわせて **staging（`elxea-agent-staging`）にも `"true"` を投入**（secret数28 → 29）し、
> staging Workerをmaster先端で再配布した（Version `127c185b`。従前のstagingは2026-08-03版で
> アンケートのコードを含んでいなかった）。
>
> **本番リッチメニューは既にroji導線へ差し替わっていた**（実測・LINE API読み取りのみ）。
> 既定メニュー `richmenu-4383dd8074a470e13a19bf2463ef8ee3`（`elxea メインメニュー（6 枠 Option A）`）の
> 枠6が `rojiをつくっています`（= `roji-survey-copy.ts` の `SURVEY_TRIGGER` と完全一致）。
> よって**いまはメニュー枠6のタップだけでアンケートが起動する**（二重の安全弁は解けている。
> 止めるなら下の「止め方」のとおりsecret側が最速）。
>
> **ONであることの確認方法（実測・誰にも1通も届かない）**: 架空のLINE userId（実在しない）で
> 枠6と同一テキストの署名付きwebhookを本番 `POST /webhook/line` に流し、
> 本番 `flow_events` に `survey.start` が1行入ること（＝入口の関門を通過した＝ON）を確認 → **その1行は削除して基準線を戻した**。
> 返信はreply（偽トークン）→ push（架空ID）の順で必ず400になるため、実顧客への送信は構造的に発生しない。
> 実顧客の到達状況は別途 `flow_events` の `survey.*` を数えて把握する（2026-08-10 JST 13:00時点で実IDの通過あり）。

### 止め方（切り戻し手順）

**アンケートは2つの独立した止め方を持つ。どちらか一方だけでも到達不可になる。**

| 止めたいもの | 手順 | 効果 | デプロイ |
|---|---|---|---|
| **アンケートそのもの**（推奨・最速） | `pnpm exec wrangler secret delete ROJI_SURVEY_ENABLED`<br>（または `printf 'false' \| pnpm exec wrangler secret put ROJI_SURVEY_ENABLED`） | 合言葉もボタンも無反応。器にも1行も書かない。**masterと同じ挙動に戻る** | **不要**（次のリクエストから即時） |
| **メニューの入口** | 差し替え後に元へ戻す場合のみ必要。2026-09-26〜 スクリプトは仮メニュー 3 枠を作るため、旧 6 枠へは `pnpm setup-rich-menu -- --channel prod --set-default <旧6枠のID> --stateless` で既定を向け直す（旧 6 枠は名前が違うので残っている。ID は `--list` で確かめる。「リッチメニューの差し替えと戻し方」節） | 元の6枠に戻る。既定を向け直すだけなので**空白の窓は生じない** | 不要（LINE側の操作のみ） |

- **削除と `"false"` 投入は等価**（ON判定は `"true"` の完全一致のみ）。
  ただし**削除の方が外から検証できる**（`wrangler secret list` の名前一覧から消えるため）。
  値は読み出せないので、`"false"` にした場合は「止まったこと」を挙動でしか確認できない。
- **途中まで答えた人も即時停止する**（「進行中だけ通す」抜け道は無い）。**答えは失われない** —— 1問ごとに
  器へ書いているため、OFFの時点までの答えは残り、再びONにすると「答えていない問い」から再開する。
- **2026-08-08に実機で1往復（ON → OFF → ON）を通してある**。切り戻しが効くことは机上ではなく実測済み。

### 安全の申告に気づく（`scripts/roji-safety-declarations.ts`）

**2026-08-08のSetaka決定**: 販売中の30銘柄はすべて茶葉のお茶で**カフェインレスの商品が1つも無い**ため、
**カフェインが苦手 / 妊娠中・授乳中**と申告した人は**自動の割当から外し、人が個別に決める**。
（アレルギーは茶葉のみと確定したため**除外処理そのものが不要**。記録としては残す。）

「人が決める」を選んだ以上、**申告に誰も気づかなければ、その人には何も届かない**。その穴を塞ぐのが本スクリプト。

```bash
npx tsx scripts/roji-safety-declarations.ts --summary   # 件数だけ（人に見せる用）
npx tsx scripts/roji-safety-declarations.ts             # 識別子つき（実際に編むとき）
```

- **通知は作らない**（pushもSlackも送らない）。**見に行けば分かる形**にとどめる。
- **読み取り専用**。出来事の置き場（`flow_events` の `survey.answer` / step=`q5`）を読む。
  カルテ（Firestore）ではなく出来事の置き場を正とするのは、**1問ごとにその場で書かれるので
  途中でやめた人の申告も必ず残る**ため。
- **運用の決めごと: 創刊号を編む前に必ず1回実行し、申告のある人を確認する。**

## LINE×Shopify 連携（LIFF / 案A）Cutover ハードゲート（QA S-2・別プロバイダの罠）

> **なぜハードゲートか（サイレント全損の回避）**: LIFF を載せる **LINE Login チャネル**と、Bot の
> **Messaging API チャネル**が **別プロバイダー**だと、`id_token` の `sub` が Messaging userId と一致しない。
> 連携は「成功」表示になるのに、Bot は当該ユーザーを**永久に未連携扱い**にする（`customer_linkages` の
> `line_user_id` が、実際に届く Messaging userId と噛み合わない）。UI もログも成功に見えるため、
> 実 follow で照合するまで誰も気づけない。**本番で LIFF 連携を有効化する前に、下記 2 点を必ず通す。**

- [ ] **G1 同一プロバイダー確認（構成）**: LINE Developers Console で、LIFF アプリが属する
      **LINE Login チャネル**と Bot の **Messaging API チャネル**が **同一プロバイダー**配下にあることを目視確認する。
      別プロバイダーなら連携を有効化しない（`LIFF_LINKAGE_URL` を本番に投入しない）。
- [ ] **G2 staging E2E で sub == Messaging userId を 1 回実測**: テスト OA（@426vlcyb）を実機で友だち追加し、
      (a) その follow / メッセージ webhook が運ぶ **実 Messaging userId** と、
      (b) 同一ユーザーが LIFF 連携して作られた `customer_linkages.line_user_id`（= id_token の `sub`）
      が **文字一致** することを 1 回実測する。一致しなければ G1 を疑い、原因解消まで本番有効化しない。
      - 参照コード: `lib/line/verify-liff-token.ts`（web-app・`sub` 抽出と `aud`/`iss`/`exp` 検証）／
        `src/lib/customer-linkage.ts`（`upsertCustomerLinkage`・非 Messaging 形式は warn ログ）。
- [ ] **G3 prod migration 適用順**: `customer_linkages` の N:1 化（`027_customer_linkage_cardinality.sql`）は
      staging 検証後に本番へ適用してから連携を有効化する（世帯共有で 500 を出さないため・QA M-1）。

## elxea-web-app Deploy

### Staging

Web app staging is handled via Vercel Preview deployments (automatic on feature branches).

### Production

```bash
# Merge to main triggers automatic Vercel production deploy
git push origin main

# Verify at https://www.elxea.com
# Check ChatBar functionality, login flows, account page
```

### Rollback

Use Vercel dashboard to promote previous deployment, or:

```bash
# Revert the merge commit
git revert HEAD
git push origin main
```

## 本番反映の実施記録

### 2026-08-08第4工程「アンケートの公開」— **スイッチはON。メニューは未差し替え（差し替え先が未定のため停止）**

**結論を先に。アンケートは本番でONにしたが、お客さんの画面にはまだ現れない。** 入口となるメニューの
差し替えが**設計上の未決事項**でできなかったため。**お客さんへの送信は1件も発生していない。**

**公開前チェック（設計文書 第8章）— 6件すべて充足。** 各件の根拠は
[roji最初のアンケートSpec](https://www.notion.so/3b570c9d064c81e6b0fcf19356e65406) 第8章の表に反映済み。

| # | 前提 | 結果 | 何で確かめたか |
|---|---|---|---|
| 1 | 合流の道筋が決まっている | [OK] | 合流の設計文書 + 決定タスク（Q1/Q2/Q3/Q5/Q6確定）。`roji-merge-holes.test.ts` 22/22 PASS |
| 2 | カルテの受け皿9項目 | [OK] | **staging Firestoreで9項目すべて書き込み→読み戻し→一致を実測**（11/11 PASS・架空ID・最後に削除して検算） |
| 3 | 出来事の受け皿（項目29・31） | [OK] | staging Postgres round-trip PASS（1本のトランザクション・必ずROLLBACK）+ 本番は器の実在を読み取りのみで確認 |
| 4 | 言葉の置き場（項目34〜41） | [OK] | 同上。原文不可侵・項目36が名前を持たない・項目39が残ることまでPASS |
| 5 | 「消せる」が全経路で通る | [OK] | **第3工程で本番実証済み**（Supabase 4表 + Firestore 2パス・`clean=true`・痕跡走査0件） |
| 6 | 90日削除の停止 | [OK] | 本番 `cron.job` は `daily-conversation-stats` 1本のみ。削除ジョブは復活していない |

**本番ベースライン（公開の前後で比較・件数とメタのみ／本文は1件も取得していない）:**

| 項目 | 公開前 | 公開後 | 判定 |
|---|---|---|---|
| ヘルスチェック | 200 | 200 | [OK] |
| `POST /api/erase`（無認証） | 401 | 401 | [OK] 鍵は効いたまま |
| 全26表の行数 | 合計1493 | 合計1493（各表も完全一致） | [OK] 1行も減っていない |
| `cron.job` | `daily-conversation-stats` 1本 | 同左（`30 18 * * *` / active） | [OK] 削除ジョブは復活していない |
| `schema_migrations` | 33件 | 33件 | [OK] migrationは1件も当てていない |
| `line_message_ledger` | 4件（最終2026-08-05） | 4件（最終2026-08-05） | [OK] **1通も送っていない** |
| `flow_events` の `survey.*` | 0件 | **0件** | [OK] 誰も到達していない |

**やったこと:**

- `ROJI_SURVEY_ENABLED` を `"true"` で本番に登録（`printf 'true' | pnpm exec wrangler secret put ...`）。
  secret数28 → 29。名前一覧に出ることを確認。**デプロイ不要・即時反映**（Secret Changeで新Versionが生成される）
- **切り戻しを実機で1往復した**（ON → deleteでOFF → 再度ON）。secret数が29 → 28 → 29と動くことを
  外から検証。**「すぐ止められる」は机上ではなく実測で確認済み**
- `scripts/roji-safety-declarations.ts` を新設（安全の申告に気づくための読み取り専用の一覧。上記「安全の申告に気づく」参照）
- `migration` は1件も当てていない。`DELIVERY_SEND_ENABLED` / `DORMANT_SEND_ENABLED` / `MARCHE_SEND_ENABLED` は
  **読みも書きもしていない**

**メニューを差し替えられなかった理由（停止の判断）:**

`pnpm setup-rich-menu -- --channel prod` は**差し替えではなく、いまと同じ6枠を作り直すだけ**だった。

- `scripts/setup-rich-menu.ts` が持つのは既存6枠のみで、**「rojiをつくっています」の枠が存在しない**
- 設計文書は「メニューの1枠を一時的に差し替える」と書いているが、**6枠のどれを譲るかを書いていない**
- メニュー画像は**6枠ぶんの文字が焼き込まれた1枚のPNG**（`assets/rich-menu/richmenu-optionA-6slot-*.png`）。
  動き（action）だけ差し替えると、**見た目と行き先が食い違うボタン**がお客さんに出る。新しい画像が要る

よって「どの枠を譲るか」＋「その画像を作る」の2つが決まるまで**勝手に決めずに停止**した。
本番の既定メニューはLINE APIで実測し、**元の6枠のまま**であることを確認済み
（`richmenu-c50d008130fd6a0617821ed4a372ef5b` = お茶の淹れ方 / 好み診断 / マイカルテ / 定期便 / 読みもの / elxeaについて）。

**アンケートが動くことの確認範囲（正直な線引き）:**

- **本番では動かしていない**（実在のお客さんで試さない・LINEの送信APIを呼ばないため）
- 代わりに**署名付きwebhookをWorkerにインプロセスで流す密閉テスト17件がPASS**（LINE送信はモックが捕捉し、
  実ネットワークへ1通も出ない）。案内 → 6問 → 伸びる1行 → 訂正 → ひとこと → 引用の許可まで通っている
- 単体68件・合流22件・staging DB往復11件・staging Firestore 11件もPASS
- **したがって「本番の実トラフィックで1回通した」証拠は無い。** これはメニュー差し替え後、
  Setaka以外の検証用アカウントで1回通すのが最も確実（未実施）

### 2026-08-08第3工程（再実行）「配布 + 鍵の登録 + 実動作確認」— **配布完了・消去は本番で実証済み**

対象ブランチ `integration/roji-prod-rollout-20260808` / 反映HEAD **`abbe862`**。
配布時刻2026-08-08T13:05Z（JST 22:05）。**Version ID `3bc02347-641c-4d68-a16b-0177ac60a47b`**。
下の「配布は未実施」の記録は本節で解消済み（Cloudflare認証はBitwardenのAPIトークンで回復）。

**外部送信は1件も発生していない。** LINEのpush / broadcast / multicast / replyを一度も呼んでいない
（`LINE_CHANNEL_ACCESS_TOKEN` を実行shellに置かなかったためdeploy-prod.shのwebhook検証もskipされた）。
リッチメニューは差し替えていない（`setup-rich-menu` 未実行）。

**配布前に見つけて直した2件（どちらも本番反映を妨げていた）:**

| 件 | 症状 | 対処 |
|---|---|---|
| `deploy-prod.sh` のreadonly衝突 | `STAGING_WORKER_URL` が `readonly` 宣言済みなのに代入プレフィックスで呼んでおり、`set -e` 下でpreflightが必ず落ちる（`line 170: readonly variable`）。**本番反映が構造的に不可能な状態だった** | 宣言を `readonly` + `export` に分離。ゲートは緩めない（`SKIP_STAGING_SMOKE` は使わない）。commit `f8fd192` |
| staging smokeのwebhookパス誤り | `POST /webhook` を叩いていたが実在ルートは `POST /webhook/line` のみ。staging / prod双方で必ず404になりsmokeゲートが恒常的に赤 | 実在パスに修正。署名なしPOSTは入口の署名検証で403（イベント処理は走らず1通も送らない）。commit `abbe862` |

**配布の内容:**

- migration: **1件も適用していない**（`MIGRATE_ONLY=NONE`）。台帳は前後とも33件で不変。
  未適用のまま残るのは設計どおりの5件（`000` / `012` / `024` / `025` / `027`。024/025/027 はdeny-list）
- `ERASE_API_SECRET`: **新規発行して本番Workerに登録**（値はBitwardenのみ。ここにも報告にも書かない）
- `ROJI_SURVEY_ENABLED`: **登録していない**（未設定＝OFF）。メニュー未差し替えとの二重の安全を維持
- `DELIVERY_SEND_ENABLED` / `DORMANT_SEND_ENABLED` / `MARCHE_SEND_ENABLED`: **読みも書きもしていない**

**配布前後の比較（本番・件数とメタのみ）:**

| 項目 | 配布前 | 配布後 | 判定 |
|---|---|---|---|
| ヘルスチェック | 200 | 200 | [OK] |
| `POST /api/erase`（無認証） | **404** | **401** | [OK] 反映済み・鍵が効いている |
| 全26表の行数 | 合計1493 | 合計1493（各表も完全一致） | [OK] 減っていない |
| `cron.job` | `daily-conversation-stats` 1本 | 同左（`30 18 * * *` / active） | [OK] 削除ジョブは復活していない |
| `schema_migrations` | 33件 | 33件 | [OK] |

**消去の実動作確認（本番・`/api/erase` 経由）— 全項目PASS**

架空の人1件（接頭辞 `ZZTESTERASE-`）を本番に作り、`POST /api/erase` で消して検算した。

- **送信の引き金にしない形で作った**（多層防御・すべてコードで裏取り）:
  1. 本番 `[triggers]` は同期(`0 18`)のみ（配信cronは2026-08-22に撤去＝完全オンデマンド）。
     休眠ナッジ・マルシェ活性化のcronは**staging限定**で本番には無い（`cron-routing.ts` / `wrangler.toml`）
  2. `customer_linkages.unfollowed_at` を非NULLで作成 → `filterEligible` が除外し、
     さらに `excludeLineUserIds` に入ってFirestore直読み経路（`unionEligible`）でも除外される
  3. `shopify_customer_id` はNULL → 日次同期のShopify metafield書込に載らない
  4. 識別子が実在のLINE ID形式（`U`+32hex）と衝突しない
  5. 全員配信はLINEの友だち宛でDB由来ではない → 種まきで宛先が増えない
- 結果: `HTTP 200` / `status: "erased"`
  - Supabase 4表から削除（`conversations` 1 / `customer_linkages` 1 / `user_identity_map` 1 / `flow_events` 1）
  - **Firestore 2パス**（`lineUsers/<架空ID>` と `users/line:<架空ID>`）。**stagingのDB層検証では覆えていなかった
    Worker経由のFirestore経路を、本番で初めて実証した**
  - 検算 `residue`: **`clean=true`**・`remaining` 全15項目0
  - 図2の「残る」側（`roji_edit_records` / `roji_delivery_months` / 匿名の言葉）は `preserved` に分離されている
  - `firestore_residue`: **`clean=true`**・全5項目0
- **痕跡走査**: 公開スキーマの全テキスト/JSON列を総当たりし、架空の人の痕跡 **0件**
- **実データ保全**: 全26表の行数が種まき前と**完全一致**（実在の行は1行も減っていない）
- **冪等性**: 同じIDをもう一度消しても `HTTP 200` / 削除0件・例外なし
- **後片付け**: 最終差分なし（本番は試験前の状態へ完全復帰）

> **「消せます」は本番の全経路で言える状態になった**（Supabase + Firestore + 検算 + 痕跡走査）。

### 2026-08-08第3工程（初回）「配布 + 鍵の登録 + 実動作確認」— **配布は未実施（Cloudflare認証切れでブロック）**

> ⚠ この記録は上の「再実行」節で**解消済み**。以下は当時の事実の記録として残す。

対象ブランチ `integration/roji-prod-rollout-20260808` / HEAD `5c19dd4`。
**本番Workerへの配布・secret登録は1つも実行できていない。** 以下は事実の記録。

**通ったもの:**

| 項目 | 結果 |
|---|---|
| working tree | clean（未コミット差分なし） |
| `npm run test:unit` | exit 0（68/68 PASS） |
| `npx vitest run` | exit 0（19 files / 96 tests PASS） |
| 本番ベースライン記録 | 下表のとおり取得（件数・メタのみ／本文は取得していない） |
| stagingへ `031` 適用 | 完了（削除ジョブ3本を解除・本番と設定が揃った） |
| 消去の実動作確認（**staging**） | **全項目PASS**（後述） |

**本番ベースライン（2026-08-08T05:40Z取得・配布していないので現在も同値）:**

- 行数: `conversations` 347 / `user_identity_map` 55 / `customer_linkages` 1 / `flow_events` 45 /
  `conversation_daily_stats` 137 / `line_message_ledger` 4 / `account_link_nonces` 1（他は0）
- `cron.job`: `daily-conversation-stats` のみ（1本・active）＝90日削除ジョブは停止済み（031適用済み）
- `POST /api/erase`: **404**（＝新コード未配布）
- ヘルスチェック `https://elxea-agent.setaka-on.workers.dev/`: **200** `{"status":"ok"}`
- 台帳: `031`〜`037` すべて適用済み（＝**配布時に当てるmigrationは無い**＝`MIGRATE_ONLY=NONE`）

**ブロッカー: Cloudflareへの書き込み認証が無い（Setakaの対応が要る）**

- ローカルwranglerのOAuthは **2026-07-27T19:19Zに期限切れ**、refreshも `400 Bad Request` で失敗
  （`~/Library/Preferences/.wrangler/config/default.toml`）。`wrangler whoami` = `Not logged in.`
- `CLOUDFLARE_API_TOKEN` は**ローカル環境変数にも無い**。
- **リポジトリにもorgにも `secrets.CLOUDFLARE_API_TOKEN` は未登録**（`.github/workflows/ci.yml` に
  2026-07-27実測済みとして明記）。よってGitHub Actions経由の配布も同様に不可。
- したがって `wrangler secret put ERASE_API_SECRET` も `wrangler deploy` も実行できない。

**解消手順（どちらか一方でよい）:**

```bash
# 案1: ローカル OAuth を張り直す（対話・ブラウザ承認が要る）
pnpm exec wrangler login

# 案2: 最小権限の API トークンを発行して使う
#   Cloudflare ダッシュボードで Workers Scripts:Edit / Account Settings:Read 相当を発行し
export CLOUDFLARE_API_TOKEN=***
```

解消後の配布コマンド（**この形のまま実行する**）:

```bash
# 1. 鍵を登録（値は対話入力・履歴とログに残さない）
pnpm exec wrangler secret put ERASE_API_SECRET

# 2. 配布（migration は当てない／リッチメニューは差し替えない）
CONFIRM=DEPLOY-PROD MIGRATE_ONLY=NONE SUPABASE_DB_PASSWORD=*** ./scripts/deploy-prod.sh
```

> ⚠ `ROJI_SURVEY_ENABLED` は **登録しない**（未設定＝OFF）。メニュー未差し替えとの二重の安全を維持する。
> ⚠ `DORMANT_SEND_ENABLED` / `MARCHE_SEND_ENABLED` には触れない（配信の実送信スイッチは
> 2026-08-22に撤去済みで、そもそも存在しない）。

**消去の実動作確認（stagingで実施・本番は未確認）**

本番へ配布できていないため、**本番の `/api/erase` 経由の確認は未実施**。
代わりにstagingのDB層（`roji_erase_person` / `roji_erasure_residue`）で通した。
明示的テスト接頭辞 `ZZTESTERASE-` の架空の人1件を16表に作り、消して検算した結果:

- 別名表の不動点解決: LINEのID **だけ**からEC顧客番号・Web識別子・`person_seq` に到達 [OK]
- 消去: 12表から削除（`conversations` 2 / `customer_linkages` 1 / `user_identity_map` 1ほか）[OK]
- 検算 `roji_erasure_residue`: **`clean=true`**・`remaining` 全項目0 [OK]
- **痕跡走査**: 公開スキーマの**全テキスト列を総当たり**で走査し、架空の人の痕跡 **0件** [OK]
- 図2の「残る」側: 匿名の言葉（`person_seq IS NULL`）・編む手間の記録・月の締め が**残存** [OK]
- 実データ保全: 種まき前と消去後の**全28表の行数が完全一致**（既存行は1行も減っていない）[OK]
- 冪等性: 同じIDを2回消しても2回目は0件・例外なし [OK]
- 後片付け: テスト行を全削除し、stagingは試験前の状態へ**完全復帰**を確認 [OK]

> **本番では未確認**。Firestore側の消去（本カルテ・未連携カルテ・comments）はWorker経由でしか
> 走らないため、**stagingのDB層検証では覆えていない**。本番配布後に `/api/erase` で
> 架空の人1件を通して初めて「消せます」が全経路で言える。

**このセッションで本番に加えた変更: 無し**（読み取りのみ。行数・cron・health・`/api/erase` すべてベースラインと同値であることを再測して確認済み）。

## Monitoring Post-Deploy

- Check Slack #alerts channel for error notifications
- Monitor Cloudflare Workers dashboard for error rate
- Check `/api/alerts/status` endpoint (requires SYNC_API_SECRET)
- Verify Notion Alerts DB for new entries
