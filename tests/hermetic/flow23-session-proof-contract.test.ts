/**
 * ハーメティック L1 — 動線23: session_id の署名が **web-app と cx-agent で完全に一致する**。
 *
 * ─ なぜこの 1 本が要るか ─
 *
 *   署名は 2 つのリポジトリに **別々の実装** で存在する:
 *     - 送る側 (web-app)  : `lib/chat/session-token.ts` … node:crypto の createHmac
 *     - 受ける側 (cx-agent): `src/lib/chat-session.ts`  … Workers の crypto.subtle
 *
 *   同じ「HMAC-SHA256 を base64url」でも、鍵の trim・文字エンコード・パディングの
 *   落とし方が 1 つでもずれると **本番で全ての session が弾かれる**。しかもその症状は
 *   500 でも 400 でもなく「チャットが会話を覚えていない」という静かな劣化なので、
 *   気づくまでに時間がかかる。型検査もリポジトリを跨げないので、ここを機械で留める。
 *
 *   下の期待値は **web-app 側の実装で実際に計算した文字列**である:
 *
 *     node -e "crypto.createHmac('sha256', secret.trim())
 *                    .update(sessionId,'utf8').digest('base64')  → base64url"
 *
 *   つまりこのテストが緑である限り、両実装は同じ答えを出す。片方の実装を触って
 *   ここが赤くなったら、それは **もう一方も同時に直さないといけない** という合図。
 */

import { describe, expect, it } from "vitest";
import { signSessionId, verifySessionProof } from "../../src/lib/chat-session";

/** vitest.config.ts の bindings と同じモック鍵。 */
const SECRET = "e2e-mock-chat-session-secret";
const SESSION_ID = "11111111-2222-4333-8444-555555555001";

/** 送る側 (web-app / node:crypto) が同じ入力から実際に出した値。 */
const EXPECTED_FROM_WEB_APP = "C7VsswAXlNmkXw_MnFw6hF1LJ-Ach3X_V96Df8Hwo7o";

describe("hermetic L1 — 動線23: 署名の相互運用 (web-app ↔ cx-agent)", () => {
  it("受ける側の署名が、送る側 (node:crypto) の出力と 1 文字も違わない", async () => {
    const actual = await signSessionId(SESSION_ID, SECRET);
    expect(
      actual,
      "web-app と cx-agent の署名がずれた。本番では全 session が弾かれ、" +
        "「チャットが会話を覚えていない」という静かな劣化になる",
    ).toBe(EXPECTED_FROM_WEB_APP);
  });

  it("送る側が作った署名を、受ける側が受理する", async () => {
    expect(await verifySessionProof(SESSION_ID, EXPECTED_FROM_WEB_APP, SECRET)).toBe(true);
  });

  it("鍵の前後の空白は両側で無視される (貼り付け由来の改行 1 文字で全滅しない)", async () => {
    /* 2026-08-30 の本番障害と同型の落とし穴。`wrangler secret put` に echo を使うと
       末尾に改行が入る。両側 trim してあることをここで固定する。 */
    expect(await verifySessionProof(SESSION_ID, EXPECTED_FROM_WEB_APP, `${SECRET}\n`)).toBe(true);
    expect(await verifySessionProof(SESSION_ID, EXPECTED_FROM_WEB_APP, `  ${SECRET}  `)).toBe(true);
  });

  it("base64url である (URL・cookie に無加工で載る文字しか含まない)", async () => {
    const sig = await signSessionId(SESSION_ID, SECRET);
    expect(sig, "`+` `/` `=` が残っていると cookie / クエリで壊れる").toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("別の session_id には別の署名が出る (署名が session に束縛されている)", async () => {
    const other = await signSessionId("11111111-2222-4333-8444-555555555002", SECRET);
    expect(other).not.toBe(EXPECTED_FROM_WEB_APP);
    expect(await verifySessionProof(SESSION_ID, other, SECRET)).toBe(false);
  });

  it("鍵が違えば受理しない / 鍵が無ければ受理しない (fail-closed)", async () => {
    expect(await verifySessionProof(SESSION_ID, EXPECTED_FROM_WEB_APP, "another-secret")).toBe(false);
    expect(await verifySessionProof(SESSION_ID, EXPECTED_FROM_WEB_APP, undefined)).toBe(false);
    expect(await verifySessionProof(SESSION_ID, EXPECTED_FROM_WEB_APP, "   ")).toBe(false);
    expect(await verifySessionProof(SESSION_ID, null, SECRET)).toBe(false);
  });
});
