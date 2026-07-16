# 個別最適化 Phase 0 — 棚卸し・データ整備（as-built）

設計正本: [個別最適化(出し分け)設計案 v2](https://www.notion.so/39f70c9d064c815f8316f458e173d770)（承認済み）
作成: 2026-07-17 / elxea-cx-agent developer。本書は Phase 0（棚卸し・調査）の as-built 記録。

> 重要な前提訂正: 設計 v2 は「43 銘柄・enjoy 0 件・story 12/43」を前提に書かれているが、
> 現・Notion Tea Menu List（Status=販売中）を実測すると **30 銘柄・enjoy 30/30・story 0/30** だった。
> 設計 v2 の数値は旧スナップショット。以降の数値は 2026-07-17 実測を正とする。

---

## 1. 好みデータはどこに何があり、いつ書かれ、誰が読むか（1 枚マップ）

好みストアは **3 系統**。SoT は **Firestore**。Supabase `customer_profiles.preferences` は
**現在どこからも書かれていない**（未使用の legacy CDP 列）→ SoT 分裂・drift の余地は無い。
設計 v2 の「4 つ目の好みストアを作らない」は、この事実により自動的に満たされている。

| # | ストア | 物理位置 | 書かれる契機 | 書き手 | 読み手（主な消費） |
|---|---|---|---|---|---|
| 1 | 診断ペルソナ | Firestore `users/{shopifyId}.persona`（連携済）/ `lineUsers/{lineUserId}.persona`（未連携） | 好み診断 3 問完了時（weight=3）、購入 webhook（weight=3）、会話抽出（weight=1） | `preference-diagnosis.ts` / `preference-pipeline.ts` | `menu-actions` / `broadcast-templates` / `delivery-*` / `target-resolver` / `segment-broadcast` |
| 2 | 会話由来 taste | Firestore `users/{shopifyId}.tasteProfile`（連携済）/ `lineUsers/{lineUserId}.tasteProfile`（未連携・LINE のみ） | 会話完了後の非同期抽出。**キーワード事前フィルタ通過時のみ** Claude Haiku で抽出 | `preference-extractor.ts` → `firestore.updateTasteProfile` / `updateLineUserTasteProfile` | 同上（persona と同じ Firestore カルテ経由） |
| 3 | CDP preferences | Supabase `customer_profiles.preferences`（jsonb） | **なし（0 writer）** | — | — |

補足（実行条件の正確な定義）:
- **会話由来 taste の実行条件**（設計 v2「連携済みユーザー限定」の正確版）:
  1. `containsPreferenceKeywords()` が true（正規表現の事前フィルタ、API 節約）
  2. Haiku 抽出が非空
  3. `customer_linkages` で shopify_customer_id が解決できる → `users/{shopifyId}` に書く
  4. 解決できない場合: **LINE は `lineUsers/{lineUserId}` に書く**（P0-6 で skip 撤廃済み・weight=1）／
     **Web は従来どおり skip**（lineUserId を持たないため）
- 診断・taste・購入はすべて `mergePersonaScores`（別軸への累積加算・上書きしない）で統合。
  会話 +1 / 購入・診断 +3。連携成立時に `lineUsers → users` へ同一構造でマージ可能（自動マージは未実装 TODO）。

---

## 2. Flavor Profile 充足監査（Status=販売中・2026-07-17 実測・30 銘柄）

データソース: Notion「Tea Menu List」DB（`ee367f6c-3ff3-4251-ad9e-0bc5a2cc7358`）、
production code と同じ `Status = 販売中` フィルタ・`Menu Name` が 5 桁の行のみ。

| 属性 | 充足 | 率 | 備考 |
|---|---|---|---|
| Category（select） | 30/30 | 100% | 緑茶 12 / 紅茶 12 / 青茶 6 |
| Flavor Profile（multi_select・末尾スペース注意） | 30/30 | 100% | 設計 v2「未監査」→ 実測 100% |
| Flavor Profile - Detailed（multi_select） | 25/30 | 83% | 5 銘柄欠落 |
| 楽しみ方（enjoy） | 30/30 | 100% | **設計 v2「0 件」から改善済み** |
| 農家の物語（story） | 0/30 | 0% | **設計 v2「12/43」→ 現販売中は 0**。要充足判断 |
| 味わい：すっきり/しっかり（number 0–5） | 24/30 | 80% | 6 銘柄欠（11301/11401/50601/51201/51501/51601） |
| 香り：甘い、熟した/青い、爽やかな（number 0–5） | 24/30 | 80% | 同上 |
| Variety（select） | 30/30 | 100% | — |

---

## 3. タグ → 出し分け軸 の写像テーブル

**発見**: 既存の `Flavor Profile` multi_select は 4 値で、実は **2 つの直交軸 × 2 極** を成す。
各銘柄はちょうど「香り 1 タグ + 味わい 1 タグ」を持ち（100% 充足）、写像は既にデータ側で完成している。
number 版（味わい/香り軸 0–5）が同じ 2 軸の連続値を 80% で持つ。設計 v2 が仮置きした
「香り系/旨み系/焙煎系/さっぱり系」の 4 分類は不要で、下の 2 軸に置き換える（焙煎/ほうじ茶は Category に存在しない）。

| 出し分け軸 | 極（タグ実値） | 件数 | number 対応列 | 未分類 |
|---|---|---|---|---|
| 軸1 香り(aroma) | `甘い、熟した香り \| リッチ` | 22 | 香り：… 高値側 | 0 |
| 〃 | `青い、爽やかな香り \| ドライ` | 8 | 香り：… 低値側 | 0 |
| 軸2 味わい/ボディ(body) | `すっきりした味わい \| ライトボディ` | 18 | 味わい：… 低値側 | 0 |
| 〃 | `しっかりした味わい \| フルボディ` | 12 | 味わい：… 高値側 | 0 |
| 粗フィルタ Category | 緑茶 / 紅茶 / 青茶 | 12/12/6 | — | 0 |
| 補助 Detailed（任意） | Flowery/Sweet/Fruity/Green/Spicy/Dry/Marine/Vegetable/Roast（9 種） | — | — | 5 銘柄欠 |

**未分類になる銘柄・タグ**: 香り/味わい 2 軸に関しては **0 件**（全 30 銘柄が両軸を保有）。
タグ整備の判断材料（Setaka 向け）:
- (a) `農家の物語(story)` 0/30 → A-1 文脈接続の「物語根拠」を使うなら要充足。使わないなら不要。
- (b) number 軸 6 銘柄欠・Detailed 5 銘柄欠 → 微細な出し分けに使う場合のみ埋める（軸の粗い出し分けには不要）。

---

## 4. 入口回答（welcome.source）の永続化確認

入口質問「どこで elxea を知ったか」の回答は **2 箇所** に記録され、永続側に残る:

| 保存先 | 種別 | 保持 | 書き手 |
|---|---|---|---|
| Firestore `lineUsers/{lineUserId}.onboarding.source` | marche/online/other | **永続** | `routes/line.ts recordWelcomeSource()` |
| Supabase `flow_events`（`welcome.source`） | 同上 | 現状 purge ジョブなし（実質永続） | `logFlowEvent()` |

結論: **90 日で消える場所（conversations 等）にしか無い入口項目は無い**。
`conversations` / `message_feedback` / `unanswered_queries` / `processed_events` は 90 日 pg_cron 削除
（`migrations/010`）だが、`flow_events`（`migrations/021`）には削除 cron が無く、Firestore カルテも永続。
→ A-3（入口別の力点）の前提「入口タグ永続化」は充足済み。追加の複製 1 行は不要。

---

## 5. オーナー連携機構（`test-linkage-kit.ts` の owner モード）

`scripts/test-linkage-kit.ts` に **staging 限定・Shopify 非接触** で実 LINE ID を
「連携済み・定期便扱い」にする owner モードを追加（合成 ID 版 setup の実 ID 版）。

```
npx tsx scripts/test-linkage-kit.ts link-owner   <LINE_USER_ID>   # 冪等 setup
npx tsx scripts/test-linkage-kit.ts status-owner <LINE_USER_ID>   # 読み取り検証
npx tsx scripts/test-linkage-kit.ts unlink-owner <LINE_USER_ID>   # teardown
```

- Shopify 顧客 ID は実 LINE ID から決定的に導出した合成値（reserved band `9009…`・`ownerSyntheticShopifyId`）。
  実在 Shopify 顧客と衝突しない。teardown は同じ LINE ID から再計算して削除（冪等）。
- 認証は必ず `*_STAGING`（fail-closed）。prod 認証情報は読まない。Shopify API は呼ばない。
- 定期便扱いは Firestore `users/{合成id}.isSubscriber=true` で成立（`resolveLinkedSubscriber` の firestore 経路）。

### オーナーの LINE ユーザー ID の特定手順（ID は推測しない）

1. オーナーがテスト OA（staging）に任意のメッセージを 1 通送る。
2. 直後に、次のいずれかで最新の実 LINE userId（`U` + 32 hex）を確認する:
   - Supabase(staging) `conversations` の `created_at` 最新行の `user_id`
   - Supabase(staging) `flow_events` の `created_at` 最新行の `user_ref`
   - Firestore(staging) `lineUsers` コレクションの `lastActiveAt` 最新ドキュメント ID
3. 得た実 ID を `link-owner <LINE_USER_ID>` に渡す。**この特定を経ずに ID を推測して連携しない**。
