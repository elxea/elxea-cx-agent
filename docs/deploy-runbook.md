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
> - staging の `DELIVERY_SEND_ENABLED` は **未設定のまま**（= dry-run）。実送信は GA 時にのみ ON にする。
>   （**本番は事情が違う**: 本番は値 `"false"` で secret が存在する。詳細は「LINE 配信の運用ゲート」節の
>   「本番の ON/OFF は `wrangler secret list` の有無では判定できない」を参照）

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

テストトークンを export してから実行する。スクリプトは `LINE_CHANNEL_ACCESS_TOKEN_TEST` を
優先して使い、起動時に対象チャネル（`test(@426vlcyb)`）をラベル表示する。

```bash
export LINE_CHANNEL_ACCESS_TOKEN_TEST=<テストチャネルのアクセストークン>
pnpm setup-rich-menu
# 出力の「🎯 対象チャネル: test(@426vlcyb)」を必ず目視確認する。
# prod(@307tzhkw) と出たら *_TEST が未設定 → 中断してトークンを設定し直す。
```

その後 LINE Official Account Manager（テスト OA 側）でリッチメニュー画像
（2500x1686px・6 分割）をアップロードする。

### 5. スタッフがテスト OA を友だち追加して確認

テスト OA（@426vlcyb）を友だち追加し、リッチメニュー表示・各ボタンの挙動・
CX エージェントとの会話を実機確認する。この段階は `DELIVERY_SEND_ENABLED` 未設定のため
配信（broadcast）は dry-run のまま。

> 更新（2026-07-27）: staging での**実送信検証は実施済み**（写真2枚つき 4/4 成功・証跡行
> <https://app.notion.com/p/3a970c9d064c8184a005cf763f2331af>）。staging で実配信を再現する手順・
> 必要 secret・OFF 復帰は「LINE 配信の運用ゲート」節を参照する（この節は初回ブリングアップの記録）。

> ⚠ 取り違え注意（最重要）: 手順 1・3・4 は **すべてテストチャネル（@426vlcyb）**。
> 本番 OA（@307tzhkw / 友だち約 48 人）のトークン・Webhook・リッチメニューには一切触れない。

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
# 3. 以降の未適用のみ適用
npx tsx scripts/migrate.ts --dry-run   # 適用予定の確認
npx tsx scripts/migrate.ts --apply     # 本適用（prod ref を HARD ASSERT）
```

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
  現状は友だち約 48 人で LINE Insight のユニーク値が null 返却域にある等、有効化前提が整っていない。
  （友だち数の根拠: LINE Insight `targetedReaches` 実測 48・2026-07-27 時点。友だち数は変動するため本ドキュメント内は
  すべて「約 48 人」で表記を統一する。無料枠ガードの見積は環境変数 `LINE_BROADCAST_ESTIMATED_RECIPIENTS_*` が正で、
  ドキュメントの数値は参考値。）
- したがって「pending 解消」を目的に 024/025 を無条件適用しない。有効化判断が出たときに、当該機能の cron/フラグ投入と
  同時に `--apply` する（両テーブルとも `IF NOT EXISTS` で冪等）。

### Deploy Order

1. **Supabase migrations** (if any pending) — 初回は上記 baseline を先に通す。
2. **elxea-cx-agent**: `pnpm deploy`（本番フル反映は `scripts/deploy-prod.sh` / deploy-prod workflow が
   preflight → migration → deploy → health(+webhook 検証) → version_skew_report を一括実行）
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
pnpm deploy

# 3. Verify production (health check only, no Claude API calls)
curl -s https://elxea-agent.elxea.workers.dev/ | jq .
# Expected: {"status":"ok","service":"elxea-agent"}

# 4. Smoke test (manual)
# - Open https://www.elxea.com
# - Send a message via ChatBar
# - Verify SSE streaming response
# - Check Slack for any error alerts
```

### Rollback

```bash
# Rollback to previous version
wrangler rollback

# Verify rollback
curl -s https://elxea-agent.elxea.workers.dev/ | jq .
```

## LINE 配信の運用ゲート（送信スイッチ / env 分離 / テスト配信）

> **この節はコマンドの正本**。運用者向けの平易な手順は `docs/line-delivery-guide.md`（および Notion 版
> <https://app.notion.com/p/39970c9d064c81dabf04f65c073d667c>）を SoT とし、本節は「エンジニア作業の実行手順」を持つ。
> 片方だけを直さない（配信まわりのコード変更時は両方を更新する）。

### 現状（2026-07-27 時点・事実）

| 項目 | 状態 | 根拠 |
|---|---|---|
| 本番 `DELIVERY_SEND_ENABLED` | **OFF**（実送信なし・dry-run）。ただし **secret 自体は「値 `"false"` で存在」する** | `delivery-orchestrator.ts` が `sendEnabled=false` で step(g) 前に非破壊 early-return。値の固定根拠は `wrangler.toml` 冒頭コメント（GA まで `"false"` 固定） |
| prod 自己承認（単独運用モード） | **有効**（`DELIVERY_ALLOW_SELF_APPROVAL_PROD="true"`） | `delivery-approval.ts` `selfApprovalRelaxed()` / 決定記録 <https://app.notion.com/p/3a870c9d064c81f986ddc7a8b805d6af> |
| 承認者の存在チェック | **常に必須**（緩和後も空は不可） | `isApprovalAuthorized()` は `approvers.length === 0` で常に false |
| 配信 DB の env 分離 | **本番反映済み**（fail-closed） | `resolveDeliveryDbId()`（`delivery-repository.ts`） |
| staging 実配信の実証 | **済**（写真2枚・4/4 成功 2026-07-27） | 証跡行 <https://app.notion.com/p/3a970c9d064c8184a005cf763f2331af> |

#### ⚠ 本番の ON/OFF は `wrangler secret list` の有無では判定できない（最重要・staging と手順が違う）

**事実**: 本番 Worker（`elxea-agent`）の secret 一覧には `DELIVERY_SEND_ENABLED` が **存在する**。
値は `"false"` に固定してある（`wrangler.toml` 冒頭コメントが SoT・GA まで変えない）ため、機能的には OFF である。
**secret が存在すること＝ON ではない。** 送信ゲートは `sendEnabled = env.DELIVERY_SEND_ENABLED === "true"` の
**文字列完全一致**であり（`src/lib/delivery-runtime.ts` / `tests/unit/golive-broadcast-dryrun.test.ts`）、
ON になるのは値が文字列 `"true"` のときだけ。`"false"` / 空 / 未設定はすべて OFF。

したがって、**本番で `pnpm exec wrangler secret list | grep DELIVERY_SEND_ENABLED` がヒットしても、それは ON の証拠にならない**
（secret の値は API で読み出せないので、名前の有無からは何も判定できない）。

**本番 ON/OFF の正しい判定方法** = cron 実行ログの `sendEnabled=` を読む:

```bash
# 本番 Worker のログを追う（--env を付けない = 本番 elxea-agent）。読み取り専用。
pnpm exec wrangler tail --format pretty
# 15 分ごとの cron tick で次の 1 行が出る（env ラベルで対象 OA も同時に確認できる）:
#   [delivery] env=prod(@307tzhkw) sendEnabled=false month=... scanned=... processed=... reaper=...
# sendEnabled=false → OFF（実送信なし）/ sendEnabled=true → ON（実送信する）
```

出力箇所は `src/lib/delivery-runtime.ts` の `console.log("[delivery] env=... sendEnabled=...")`、
ラベル `prod(@307tzhkw)` / `test(@426vlcyb)` は `src/lib/delivery-channel.ts` が組み立てる。

> **staging とは確認方法が違う（混同禁止）**: staging（`elxea-agent-staging`）は「**未設定＝OFF**」で運用しており、
> 後述のテスト配信手順では `secret list --env staging | grep DELIVERY_SEND_ENABLED` が **出ないのが正**。
> この「出ないのが正」は **staging 限定のローカル規約**であって、**本番には当てはまらない**
> （本番は値 `"false"` で存在するのが正常状態）。本番に staging の確認法を当てると ON と誤読する。

> **なぜ secret を消して「未設定」に揃えないか**: 現状の値 `"false"` で機能的に OFF は成立しており、
> 本番 secret を触ること自体が事故リスク（誤削除・誤投入）を生む。よって **実状態は変えず、表記側を実態に合わせる**方針を採る
> （2026-07-27 判断）。`DELIVERY_SEND_ENABLED` の本番 secret を GA 前に put / delete しない。

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

### 実送信スイッチ ON の手順（Setaka の GO 後・Tier 2）

#### ⚠ ステップ0（省略禁止）: Approved 行の全量監査

**なぜ必須か**: `DELIVERY_SEND_ENABLED` が OFF の間、orchestrator は **Notion を一切書き換えない**
（非破壊プレビューで early-return し、`setStatus(Sending)` も `writeDeliveryResult` も走らない）。
このため承認済みの行は **Status=Approved・送信済み=false のまま無期限に滞留**する。
一方 `queryDueDeliveries()` の filter は `Status=Approved AND 送信済み=false AND 配信予定日時 <= now` であり、
**過去日時の Approved 行は「送信待ち」として常に該当する**。
よってスイッチを ON にすると、**次の cron tick（最大15分後）に滞留分が一斉に実送信される**。

手順（ON の直前に毎回実施）:

1. 本番「配信コンテンツ」（`f95bb981-3c1a-4b6e-abd2-8b39551f6492`）を **Status=Approved で絞り込み、全件列挙**する。
2. 各行について次を確認する。
   - 配信予定日時が**過去でないか**（過去 = ON 直後に発火）。
   - **いま送ってよい内容か**（検証目的・下書き・古い告知の混入がないか）。
   - `送信済み` が false か（true なら再送されない）。
3. 送らない行は **Status を Draft に戻す**（削除しない）。
4. Approved に**意図した行だけ**が残った状態を確認してから ON に進む。

#### ON / OFF

```bash
# ON（本番の実送信を有効化。確認フラグ必須・deploy はしない）
bash scripts/go-live-enable-send.sh --confirm-i-really-want-to-send-real-line

# OFF（即座に dry-run 復帰・実送信を再封鎖）— 次の 2 通りはどちらも等価に OFF
pnpm exec wrangler secret delete DELIVERY_SEND_ENABLED                 # (a) secret ごと削除（未設定=OFF）
printf 'false' | pnpm exec wrangler secret put DELIVERY_SEND_ENABLED   # (b) 値を "false" にする（GA 前の既定状態）
```

**OFF の判定は「secret の有無」ではなく「値が `"true"` でないこと」**（`=== "true"` の完全一致）。
(a) と (b) は機能的に同じ OFF であり、**GA 前の本番の既定状態は (b)**（値 `"false"` で存在）。
実際に OFF へ戻ったことは `pnpm exec wrangler tail` の
`[delivery] env=prod(@307tzhkw) sendEnabled=false` で確認する
（`secret list` では判定できない — 前掲「本番の ON/OFF は `wrangler secret list` の有無では判定できない」節）。

ON 後は **最初の1本を実機受信で確認**してから後続を承認する。

### テスト配信の手順（検証環境・お客さまに届かない）

> **`--env staging` を必ず付ける。付け忘れたコマンドは本番 Worker（実顧客 OA）への操作になる。**

1. **テスト用 DB に行を作る**: 「[TEST] 配信コンテンツ (staging/@426vlcyb)」
   （<https://app.notion.com/p/3a970c9d064c816aaf11cf790334957a>）に本番と同じ手順で作成し Approved にする。
   本番「配信コンテンツ」には**作らない**。
2. **staging の送信スイッチを一時 ON**:

   ```bash
   printf 'true' | pnpm exec wrangler secret put DELIVERY_SEND_ENABLED --env staging
   ```

3. **配信を待って実機確認**（テスト OA @426vlcyb・最大15分 + 配信予定日時）。写真の順序・改行・文字化けを目視する。
   Notion 側の書き戻し（Status=Sent / 送信結果 / 消費実績 / sent_at）も確認する。
4. **必ず OFF に戻す**（戻し忘れると以降のテスト承認が送信され続ける）:

   ```bash
   pnpm exec wrangler secret delete DELIVERY_SEND_ENABLED --env staging
   pnpm exec wrangler secret list --env staging | grep DELIVERY_SEND_ENABLED   # 出ないのが正
   ```

   > ⚠ **この「出ないのが正」は staging 限定**（staging は「未設定＝OFF」で運用しているため）。
   > **本番に同じ確認法を当てない** — 本番は値 `"false"` で secret が存在するのが正常状態であり、
   > `secret list` にヒットしても ON ではない。本番の判定は cron ログの
   > `[delivery] env=prod(@307tzhkw) sendEnabled=false`（前掲節）で行う。

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
| 特定1件を止める | Notion で Status を **Approved → Draft** | 予定時刻前なら送信対象から外れる。時刻到来後・cron 実行中は間に合わない可能性あり |
| 本番の配信を全部止める | `pnpm exec wrangler secret delete DELIVERY_SEND_ENABLED`（または `printf 'false' \| pnpm exec wrangler secret put DELIVERY_SEND_ENABLED`） | 以降の全経路が dry-run（非破壊プレビュー）へ復帰。**削除と `"false"` 投入は等価**（OFF 判定は「値が `"true"` でない」）。Approved 行は滞留する（再 ON 時はステップ0 を再実施）。復帰確認は `wrangler tail` の `sendEnabled=false` |
| staging の配信を止める | `pnpm exec wrangler secret delete DELIVERY_SEND_ENABLED --env staging` | 検証環境のみ停止 |
| 自己承認を厳格モードへ戻す | `pnpm exec wrangler secret delete DELIVERY_ALLOW_SELF_APPROVAL_PROD` | 独立承認者必須（fail-closed）へ即復帰。チェック本体はコードに残存＝可逆 |
| 画像つき配信を止める | `pnpm exec wrangler secret delete R2_API_TOKEN` | 画像つき行の承認 pin が fail-closed（テキストのみ配信は継続） |
| コードごと戻す | `wrangler rollback` | 直前バージョンへ（secret は消えない・`keep_vars = true`） |

**送信済みは取り消せない**。訂正はお詫び・訂正配信を新規作成 → 承認で行う。

### 残存リスク（単独運用モードの明示）

- **per-配信の人間ゲートが1点に縮退している**。従来の「著者 != 承認者」による二人目の確認は
  `DELIVERY_ALLOW_SELF_APPROVAL_PROD="true"` の間は働かず、配信ごとの人的チェックは
  **「Notion に行を作り Status=Approved にする」その一操作**のみになる。
  残る自動ゲートは形式検査（承認者の存在・日時到来・画像形式/サイズ・コンテンツハッシュ照合・無料枠台帳・
  `DELIVERY_SEND_ENABLED`）であり、**内容の妥当性・宛先の妥当性は検査されない**。
- したがって **Notion「配信コンテンツ」の書き込み権限が、実質的な配信統制そのもの**になる。
  当該 DB の編集権限を持つ人を増やすことは「本番配信を単独で実行できる人を増やす」ことと等価として扱う。
- 緩和は可逆。運用体制に二人目を置ける段階でフラグを削除し、独立承認者必須へ戻す。

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

## Monitoring Post-Deploy

- Check Slack #alerts channel for error notifications
- Monitor Cloudflare Workers dashboard for error rate
- Check `/api/alerts/status` endpoint (requires SYNC_API_SECRET)
- Verify Notion Alerts DB for new entries
