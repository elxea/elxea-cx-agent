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
