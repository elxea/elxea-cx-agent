# events gatewayの契約（CDP統合Stage 1）

**一言で** — 顧客に起きた出来事を書く口を1本に決め、その口の形（エンドポイント・payload・冪等キー）をここで固定する。

**結論・状態** — Stage 1で確定した契約。以降の実装はこの契約に従う。書込先は当面いまのまま（既存5経路は透過で通す）で、同じ出来事をL0 `customer_events` にも積む二重書きの段。

**Ask** — 共有（FYI）。この文書は実装者向けの契約書で、判断を求めるものではない。設計判断の正本は統合設計 §3-1 / §3-2 / §5。

設計の正本: `/Users/setaka/github/circl/agents/circl-boss/deliverables/cdp-design-final-20260828.md`
スキーマの正本: `src/db/migrations/040_cdp_subjects_and_edges.sql` / `041_cdp_customer_events.sql` / `042_cdp_erasure_subject_scope.sql`

---

## 1. なぜ口を1本にするのか

いま「その人に何が起きたか」を書く先が5経路に散っている。

| # | 経路 | 書込先 | いまの語彙 |
|---|---|---|---|
| 1 | `logFlowEvent`（`src/lib/flow-events.ts`） | Supabase `flow_events` | `FlowEventName` 33値 |
| 2 | `recordBehaviorEvent`（`src/lib/firestore.ts`） | Firestore `users/{id}/behaviorLog` | `BehaviorAction` 14値 |
| 3 | `recordProductRating`（`src/lib/product-ratings.ts`） | Supabase `product_ratings` | `RatingSource` 4値 |
| 4 | 購入（`src/lib/shopify-order-webhook.ts` → `preference-pipeline`） | Firestoreカルテ | なし（購入は1種） |
| 5 | rojiアンケート（`src/lib/roji-survey-record.ts`） | Supabase `roji_*` + Firestore | `flow_events` の `survey.*` |

散っているせいで起きていること:

- **同じ出来事が2か所から書かれても、二重かどうかを言う場所が無い**（persona二重加算 = C-3）。
- **語彙が合わないと出来事が捨てられる**。cx-agent側は `src/routes/web.ts` の `VALID_WEB_EVENTS` が400を返す1か所。
- **未連携の人の出来事は無言で捨てられる**（D1 / T-12）。捨てたことすら残らない。

L0は「起きたことをそのまま1本の追記に積む」層で、解釈（カルテ・persona・セグメント）はL1がL0から再計算する。**積む側は判断しない。**

---

## 2. エンドポイント

### `POST /api/events`

cx-agentの外（いまはelxea-web-app）から出来事を積むための口。cx-agent内部の5経路はHTTPを経由せず `throughGateway` を直接呼ぶ（同じプロセス内でHTTPを往復させる意味が無いため）。

**認証**: `X-API-Key: <SYNC_API_SECRET>`。既存の共有秘密をそのまま使う。
新しい秘密を作らないのは、本番への配布がSetakaの判断事項になり、段がそこで止まるため。

**リクエスト**

```jsonc
{
  "events": [                        // 1 リクエスト 20 件まで
    {
      "event_type": "behavior.view_content",   // 必須。未知でもよい（§4）
      "channel": "web",                        // 必須。未知でもよい
      "identifier_kind": "web_anonymous_id",   // 必須。§3 の語彙（閉じている）
      "identifier_value": "…",                 // 必須。生の値（L0 には残らない）
      "dedupe": "article-slug@2026-08-29T01:02:03.000Z",  // 必須。§5
      "source": "web-app.behavior",            // 必須。slug
      "occurred_at": "2026-08-29T01:02:03.000Z", // 任意。省略時は受信時刻
      "payload": { "contentId": "…" }          // 任意。PII 禁止（§6）
    }
  ]
}
```

**レスポンス（200）**

```jsonc
{
  "accepted": 1,
  "results": [
    { "index": 0, "stored": true, "schema_ok": true }
  ]
}
```

`stored: false` のときは `reason` が付く。**`subject_id` は返さない**（設計 §3-1「表示しない・URLに出さない」）。

**400になるのは3つだけ**: 認証失敗（401）/ 本文がJSONでない / `events` が配列でない・件数超過。
**語彙が未知であることは400にしない**（§4）。

---

## 3. 識別子（`identifier_kind`）— ここは閉じている

`identity_edges.identifier_kind` のCHECKと1対1。正本は `src/lib/cdp/event-vocabulary.ts` の `IDENTIFIER_KINDS`。

| kind | 中身 | 主体の解決に使うか |
|---|---|---|
| `line_messaging_uid` | Messaging APIのuserId | ○ |
| `line_login_uid` | LINE Loginのsub | ○ |
| `shopify_customer_id` | 顧客番号（数字。`gid://` 形は渡す前に正規化） | ○ |
| `web_anonymous_id` | Webの匿名来訪者に配る不透明ID | ○ |
| `web_session_id` | 既存のwebセッションID | ○ |
| `email_hash` | メールのhash | **×（SEC-1）** |

出来事（何が起きたか）は観測の揺らぎがあるので語彙を開くが、**識別子の種類が増えるのは設計判断であって揺らぎではない**ので閉じる。

**SEC-1**: `email_hash` は観測の記録としてのみ置く。同一emailを根拠に主体を結ぶ経路は、コードにもSQLにも存在しない（`RESOLVABLE_IDENTIFIER_KINDS` に入っておらず、042の `roji_resolve_identity` にも枝が無い）。**生アドレスは決して渡さない。**

---

## 4. 語彙（`event_type` / `channel`）— ここは開いている

### 既知の語彙

正本は `src/lib/cdp/event-vocabulary.ts`。

- `behavior.<action>` — 行動語彙15値（cx-agentの14値 + web-appにしか無かった `audio_play`）。web-appの10値・zodの7値はこの部分集合。
- `flow.<name>` — `FlowEventName` 33値（`.` は `_` に畳む。例 `survey.answer` → `flow.survey_answer`）。
- 独立した出来事 — `purchase.order_paid` / `rating.submitted` / `survey.answer_recorded` / `diagnosis.answer`。

`channel` の既知は `line` / `web` / `shopify` の3値。`shopify` はTSの型（`BehaviorChannel = "line" | "web"`）に無いが、注文webhookが実際に書いている値である。**実在するものを語彙から外しても、実在するほうが「未知」になるだけで何も直らない。** 型を合わせるのはStage 5。

### 未知だったときにどうするか（E1）

**弾かない。** `schema_ok = false` を立てて保存し、200を返す。

- 未知の行は部分index `customer_events_unknown_type` で安く数えられる。
- 積み上がったら「語彙を足す」か「送り手を直す」かを人が決める。
- 拒否されるのは **形が壊れている**ときだけ（`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$` に合わない・64文字超）。形の検査は語彙の検査ではない。

「知らない出来事が起きた」を「無かったこと」に変えないための非対称である。

### Stage 1では既存の400を残す（意図的なずらし）

`src/routes/web.ts` の `POST /api/chat/event` は `VALID_WEB_EVENTS` に無いactionを400で返す。Stage 1では **L0に積んでから、応答は従来どおり400を返す**。

- 完了条件「既存読み出しの挙動が1つも変わらない」を守るため（応答コードは既存クライアントとの契約である）。
- E1が守りたいのは「出来事が消える」ことで、それはL0に積んだ時点で守られている。
- 400を落とすのは語彙がL0の登録簿に一本化されたあと（Stage 4）。それまでの進捗はratchet `event-vocabulary-drop-sites`（1 → 0）が固定する。

---

## 5. 冪等キーの作り方（この節が正本）

L0の `idempotency_key` はgatewayが組み立てる。呼ぶ側が渡すのは `dedupe` だけ。

```
idempotency_key = "<source>:<subject_id>:<event_type>:<dedupe>"
```

- **`subject_id` を使う**のは、生の識別子を鍵に入れないため（E5）。この列を見ても誰のことか分からない。
- **200文字を超えたら切り詰める**（041のCHECKと同じ上限）。
- `customer_events.idempotency_key` はUNIQUE。2回目の挿入は静かに落ちて `reason: "duplicate_idempotency_key"` を返す。**これは失敗ではない**（二重加算が構造的に止まった、という結果そのもの）。

### `dedupe` の決め方

**同じ現実の出来事なら、何度計算しても同じ文字列になること。** これだけが要件。

| 出来事 | `dedupe` の例 | なぜ |
|---|---|---|
| 注文 | `order:<orderId>` | 注文IDがその出来事を一意に決める |
| 商品評価 | `<productNo>@<occurredAt>` | 同じ商品を後で付け直したら別の出来事 |
| フローのタップ | `<step>/<value>@<occurredAt>` | タップは繰り返されうるので時刻まで含める |
| 行動ログ | `<contentId|productId|->@<occurredAt>` | 同上 |
| アンケートの回答 | `<questionId>@<occurredAt>` | 同上 |

`occurredAt` を含めるときは **呼ぶ側で1回だけ決めた値**を使う（`Date.now()` を2回呼ぶと別の鍵になり、再送で2行になる）。

---

## 6. payloadに入れてよいもの

**入れてよい**: slug（`^[A-Za-z0-9_.\-]{1,40}$`）・番号・短い属性・列挙値。

**入れてはいけない**:

- 生のLINE userId / LINE Loginのsub（E5: 生値は `delivery_identity` 1表のみ）
- メールアドレス（hashもpayloadには入れない。edgeにだけ入れる）
- 会話本文・自由文（本文の置き場は `conversations` / `roji_words` であってL0ではない）
- 氏名・住所・電話番号

`identifier` は主体の解決に使うだけでpayloadには落ちない。**入れないように気をつける**のではなく、**入れる場所が無い形**にしてある。

gatewayはpayloadに `legacy_write` を1つ足す（§7）。呼ぶ側はこのキーを使わない。

---

## 7. 「無言で捨てない」（T-12）

Stage 1のgatewayは、元の書き込みが何をしたかを必ずL0に残す。

```jsonc
"payload": {
  "…呼ぶ側が渡したもの…",
  "legacy_write": { "status": "skipped", "reason": "not_linked_to_shopify" }
}
```

`status` は `ok` / `skipped` / `failed` の3値。`reason` はslug。

これで「未連携だから記録しなかった」が **数えられる**（`payload->'legacy_write'->>'status' = 'skipped'` をGROUP BYするだけ）。
D1の無言skip（`firestore.ts` の未連携時return）は、分岐が消えるのはStage 5だが、**Stage 1の時点で「消えたこと」が見えるようになる**。

積めなかったとき（主体が出せない・形が壊れている）は1行ログに理由を出す。**理由なしで戻る枝を作らない。**

---

## 8. 既存の書き込みとの関係（透過で通す）

```ts
// Stage 1: gateway 経由（L0 にも積む）
await throughGateway(supabase, fact, () => logFlowEvent(supabase, input));

// gateway を外すとき: これだけに戻る
await logFlowEvent(supabase, input);
```

- 元の書き込みの返り値・例外は **そのまま素通し**する。
- L0への追記は **決してthrowしない**（失敗しても元の経路は成功のまま）。
- 元の書き込みが落ちたら、L0に `legacy_write.status = "failed"` を積んでから例外を投げ直す。

段の境界を「止めても壊れない」ところに置く、の実装である。

### 払っているコスト（明記）

L0への追記は **awaitする**。呼ぶ側から見ると、1件につきSupabase往復が最大3回増える（edgeを引く / 主体を発行する / L0に積む。2回目以降の同じ人は2回）。

`await` にしたのは、投げっぱなしにするとWorkerの後片付けで落ちた分が**どこにも残らない**（= 出来事を捨てたのと同じ）ためで、Stage 1でいちばん守りたいものと正面から衝突するから。

ただしこれは無料ではない。`logFlowEvent` はLINEのタップごとに呼ばれ、`roji-survey-handler` のように `await` する呼び出し側もある。応答が体感で遅くなる余地は残っている。**Stage 2でL0への追記をまとめ書き（1リクエストに複数件）へ寄せる**のを前提とし、それまでは往復増を受容する。

---

## 9. 消去との関係（GDPRゲート）

`customer_events` と `identity_edges` は **列挙で自動的に消去の対象になる**（042）。

- 037の「人を指す列の名前を語彙として持ち、その列を持つ表を毎回列挙する」に `subject_id` を足した。新しいCDPの表が `subject_id` を使う限り、登録作業なしで消える側に入る。
- `subjects` は行を消さず `retired_at` を立てる（外部キーを壊さないため）。消去後に残るのは、どの識別子とも結びつかない26文字だけ。
- 検算（`roji_erasure_residue`）は、借りた鍵から辿る数え方に加えて **辿らずに数える孤児検査** を持つ（`cdp_retired_subject_orphans`）。edgesが消えて辿れなくなっても取りこぼしに気づける。

**新しい表を足すときは `subject_id` という列名を使うこと。** 別の名前を発明すると消去の列挙から漏れる（`tests/db/roji-erasure.db.test.ts` が「人っぽい列名なのに語彙に無い」を検出する）。

---

## 10. E4（追記専用）と例外表

`subjects` / `identity_edges` / `customer_events` のUPDATE / DELETEはPostgresトリガが `RAISE` する。

**例外は1つだけ**: GDPR消去経路が `set_config('app.erasure_context', 'on', true)`（= `SET LOCAL`）を立てたとき。トランザクションを抜ければ自動的に外れるので、呼び出し側が立てっぱなしにすることはできない。

`subjects` だけは `retired_at` のUPDATEを追加で許す（同じ例外表の下で）。`subject_id` / `created_at` はどの経路からも不変。

---

## 11. Stage 2 — 連携を追記1行にし、横断読み出しをcanonical経由にする

**この節を足した理由** — §1〜§10はStage 1（出来事を書く口）の契約で、Stage 2が足した「人の同一性を書く口」の契約がどこにも無かった。スキーマの正本は `src/db/migrations/043_cdp_subject_links.sql`、判断の正本は統合設計 §3-1 / §4 C-1（★11）/ §6-1 Stage 2。ここは実装者が最初に読む索引に留め、二重に書かない。

### 何が変わったか（1行で）

「同じ人だ」と分かったときに **既存行を書き換えず `subject_links` に1行足す**。読み出しは、その追記の連結成分を解いた結果を **旧joinに足して** 引く。

### 連携の3経路とbasis

`basis` は `subject_links` のCHECKと `src/lib/cdp/subject-links.ts` の `LINK_BASES` が1対1。**ここは閉じている**（識別子の種類と同じ理由 — 増えるのは設計判断であって観測の揺らぎではない）。

| 経路 | 呼び出し元 | basis |
|---|---|---|
| LIFF連携 | `src/routes/identity.ts` `identityLinkLiffHandler` | `liff_id_token` |
| LINE純正Account Link | `src/lib/account-link.ts` `handleAccountLinkEvent` | `line_account_link` |
| 匿名セッションの昇格 | `src/routes/identity.ts` `identityLinkHandler` / `identityLinkLineHandler` | `anonymous_promotion` |

**SEC-1**: `email_equality` はこの語彙に**無い**。DBのCHECKにもTSのunionにも入っていないので、メール等値で人を結ぶ経路は型として存在しない。ここに値を足すことは「その根拠で人を結んでよい」という決定そのものである。

**J-4**（1 Shopify顧客に複数LINEを束縛しない）: DBトリガ `cdp_subject_links_j4_guard` が、その link を足すと1つの連結成分にLINEトークIDが2本入る場合に `23514` で落とす。**HTTPの409は従来どおり `customer_linkages` のUNIQUE衝突から出る**（409を返す経路は増えても減ってもいない）。J-4が覆ったらこのトリガを落とすだけでよい（スキーマは触っていない）。

### 読み出し（★11の恒久解）

```
読む user_id の集合
  = 旧join（unified_user_id + user_identity_map の3列 + 元のsession_id）
  + canonical解決（subject_links の連結成分から引いた鍵）
```

- 組み立ての正本は `src/lib/supabase.ts` の `unionCrossChannelUserIds`（純関数）。**足すだけで旧の要素を1つも削らない。**
- canonical側は `cdp_canonical_identifiers(kind, value)` RPC（`src/lib/cdp/canonical.ts` が呼ぶ）。落ちても・主体が未発行でも `resolved: false` で戻り、呼び出し側は旧joinだけで読む＝**Stage 2以前とまったく同じ挙動**になる。これが「フォールバック付き読出」の実体で、`extraUserIds` を渡すのをやめれば元に戻る。
- `email_hash` では引けないし、返り値にも入らない（SEC-1。RPC側にも枝が無い）。

**LINEとWebで扱いが非対称なのは意図的**:

- LINE側（`src/routes/line.ts`）は `identity.isLinked || canonical.linked` で横断を開く。webhookのuserIdはLINE署名で検証済みで、linkもサーバ検証済みの経路でしか作られないため。
- Web側（`src/routes/web.ts`）は **[SEC-3] のゲート（`crossChannelHistoryAllowed`）を一切緩めない**。canonicalができるのは「既に横断してよいと決まった人について読むuser_idを増やす」ことだけ。web の session_id は「知っているだけ」の弱い証明だから。

**runAgentに渡す `isLinked` はStage 2では変えない**。あれは「連携済み向けの個別最適を開くか」で、その読み出しは `effectiveUserId` をキーにする。Stage 2では `effectiveUserId` は旧解決のままなので、ここだけtrueにすると存在しないキーでカルテを引きにいく。カルテ側をcanonicalに寄せるのはStage 3。

### materializeを作り置かない（設計 §9 への回答）

設計は緩和策として「materialize + 連携完了時の即時再解決」を挙げているが、**作り置きは作らなかった**。毎回連結成分を辿る形なら (a) 古くなる窓が構造的に存在せず（＝「即時再解決」は常に成立）、(b) 読み手のいないデータ（E7）を作らずに済む。本番連携0件・連結成分は数個という規模では毎回辿るほうが安い。規模の見張りは日次突合が `max_component_size` を毎日出すことで行い、速さが問題になったら読み口の形を変えずに作り置きを足せる。

### 消去（GDPR）

`subject_links` と `delivery_identity` は **列挙で自動的に消去の対象になる**。043が037/042の「人を指す列の名前の語彙」に `subject_a` / `subject_b` を足したため、どちら側に居ても消える（列ごとに1回ずつ消す既存のloopがそのまま効く）。

加えて `roji_resolve_identity` を **linkの連結成分まで広げた**。広げないと「LINEで消してくれ」と言われたときにlinkの向こう側の主体が残る（台帳経由でも届くことは多いが、その台帳はStage 5で消える）。検算 `roji_erasure_residue` の孤児検査にも `subject_links` / `delivery_identity` を足した。

### 観測（5営業日の突合）

`cdp_stage2_parity()`（読み取り専用）が1回の呼び出しで新旧の食い違いを数え、既存の日次tick（`0 18 * * *` / `src/index.ts` の `runDailySync`）が1行のJSONログに落とす。**新規cronは作らない**（Cloudflareのcron triggerは5本上限を使い切っている）。

一致した1日 = `linked_without_link` / `delivery_identity_missing` / `multi_line_components` が3つとも0（＝ `in_agreement: true`）。判定条件はSQL側が正本で、TS側は呼んでログに落とすだけ。

---

## 12. Stage 3 — 解析がL0を取りに来る口と、突合の是正

**この節を足した理由** — §11までは「書く口」と「人の同一性を書く口」の契約で、Stage 3が足した**読み口**（解析側が日次でL0を取りに来る経路）の契約がどこにも無かった。スキーマの正本は `src/db/migrations/044_cdp_stage2_parity_map_agreement.sql` / `045_cdp_l0_analytics_readout.sql`、判断の正本は統合設計 §4-5 / §5 E8' / §6-1 Stage 3。ここは実装者が最初に読む索引に留める。

### なぜ「取りに来る」形なのか

L0は Supabase にあり、解析（`persons` / `purchases` と JOIN する場所）は Mac 上の SQLite にある。Workers からローカルファイルには書けないので、**書込は Supabase が受け、日次で SQLite が吸い上げる**（設計 §4-5）。押し込む側を作ると Worker が Mac の状態を知る必要が出るので、取りに来る側に倒した。

Supabaseの service role key を Mac に配る形も選べたが採らなかった。あの鍵は**L0以外のすべての表を読み書きできる**全権鍵で、吸い上げに要るのは L0 の読み取りだけだからである。既存の共有秘密（`SYNC_API_SECRET` / `X-API-Key`）をそのまま使い、**新しい秘密を増やさない**（§2 と同じ方針）。

### エンドポイント（3つとも GET・読み取り専用）

| 口 | 返すもの | 使う側 |
|---|---|---|
| `GET /api/cdp/l0/events?after_seq=&limit=&day=` | L0の行（`event_seq` 昇順） | 吸い上げ本体 |
| `GET /api/cdp/l0/daily-counts?from=&to=` | 日ごとの件数（JST） | E8' の突合 |
| `GET /api/cdp/l0/subject-map?after_edge_seq=&limit=` | 主体（canonical）↔ Shopify顧客番号 | `persons.subject_id` の 1:1 |

実装は `src/routes/cdp-export.ts`、SQL側は 045 の `cdp_l0_daily_counts` / `cdp_subject_shopify_map`。呼ぶ側は `elxea-cdp/l0-ingest.mjs`（同リポジトリではない）。

**返さないもの（意図的）**: 生のLINE userId / LINE Loginのsub / `email_hash` / 会話本文。L0の`payload`は契約上PIIを持たない（§6）。主体の対応で返す生の鍵は Shopify顧客番号だけで、これは既にSQLiteの`persons.ec_customer_id`にある値＝**置き場が増えない**。生LINE userIdを吐けばE5（置き場は`delivery_identity`1表）が破れる。

**`day` がある理由**: L0は追記専用だが**GDPR消去だけが例外**で行を消す（§10）。消去が上流で起きると水位より下の行が黙って減り、前にしか進まない水位では永久に拾えない。突合が食い違いを見つけた日はその日を丸ごと引き直して写しを合わせる — `day` は**「消えたこと」を写しに伝える唯一の経路**である。

### 日の境界はJST（ずれると毎日食い違って見える）

突合の軸は `recorded_at` を**JSTの日**に丸めた値。`occurred_at`（送り手の申告）で切ると遅れて届いた出来事が過去の日に入り、緑になった日の数が後から増える。JSTなのは吸い上げジョブがJSTで回るから。3か所が同じ境界であることが要件:

- SQL側 … 045 の `(recorded_at AT TIME ZONE 'Asia/Tokyo')::date`
- TS側 … `src/routes/cdp-export.ts` の `jstDayBounds`（`tests/unit/cdp-export.test.ts` が固定）
- SQLite側 … `elxea-cdp` の `customer_events.recorded_day`

### E8'（2つのL0が同じ数を持っているか）

`cdp_l0_daily_counts` が Supabase 側の数を返し、吸い上げジョブが自分の数と突き合わせる。**閉じた日だけ**を見る（今日は取り込んだ直後にも新しい出来事が届くので、突合すると毎回食い違って見える）。食い違った日は引き直し、それでも直らなければジョブが非ゼロで終わる = 日次ジョブが赤くなる。「緑になるまで次の段へ行かない」の歯はここ。

### 突合の是正（Stage 2 の QA 指摘 MID-1）

`cdp_stage2_parity()` の `in_agreement` に `identity_map_without_link` が入っていなかった。★11 の断線は `user_identity_map` を引く読出（`getCrossChannelMessages` / `resolveUnifiedUserId`）で起きているので、これは「新旧一致」の**旧**の側に確かに含まれる台帳である。数は043の時点から返していたが判定に使われておらず、「観測はしているが合否に効かない」形だった。

044で判定に足した。一致した1日は次の**4つ**がすべて0:

`linked_without_link` / `identity_map_without_link` / `delivery_identity_missing` / `multi_line_components`

あわせて `in_agreement_by`（どれで落ちたかの内訳）を返す。**過去の日も後から判定し直せる** — 数そのものは043の時点から日次ログに出ているので、観測をやり直す必要は無い。

⚠ `user_identity_map` にStage 2より前の行が残っていると `in_agreement` は false のままになる。**これは誤検知ではない**: その人はいまも旧台帳経由でしか横断読み出しに乗っておらず、Stage 5で `user_identity_map` を落とす（T-6）と横断が黙って消える。0になるまで観測を閉じないのが正しい。
