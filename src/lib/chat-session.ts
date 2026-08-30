/**
 * Web チャットの session_id の **真正性** を確かめる（署名検証）。
 *
 * ─ なぜ要るか（QA 指摘 P1/P2/P3 の共通の前提）─
 *
 *   `session_id` はこれまで **ブラウザが localStorage で自作した UUID** を body に
 *   そのまま入れて送っていただけで、サーバは一切検証していなかった。会話は
 *   `conversations.user_id = session_id` で保存され、identity の束縛にも使われるので、
 *   「他人の session_id を知っている」だけで次が全部できてしまう:
 *
 *     P1 他人の匿名 session を自分のものとして恒久的に結びつけ、持ち主を締め出す
 *     P2 他人の Web 会話を読む
 *     P3 自分の発言を他人の会話ストリームに書き込む
 *
 *   歯を 1 枚ずつ足しても、**前提（誰でも名乗れる）が変わらない限り**同じ形の穴が
 *   出続ける。よって「サーバが発行したものだけを受け付ける」に前提ごと変える。
 *
 * ─ 何を証明するか / しないか ─
 *
 *   証明する: この session_id は **自分たちが発行した** ものである。
 *   証明しない: 目の前の呼び出し元がその session の持ち主である。
 *   後者は httpOnly cookie に入れて web-app が持ち回ることで担保する（盗まれれば
 *   使えるのは、あらゆる bearer token と同じ）。重要なのは **総当たり・推測・
 *   「知っているだけ」では作れない** ようになること。
 *
 * ─ 形式（web-app 側と厳密に一致・SoT）─
 *
 *   proof = base64url( HMAC-SHA256( key = CHAT_SESSION_SECRET.trim(), msg = session_id ) )
 *   base64url = 標準 base64 の `+`→`-` / `/`→`_` / 末尾 `=` 除去
 *
 *   ⚠ session_id 自体は **bare な UUID のまま**にしてある。`conversations.user_id` /
 *     `user_identity_map.web_session_id` / `identity_edges.identifier_value` が
 *     この生の UUID を鍵として持っているので、形式を変えると既存の会話が全部迷子に
 *     なる。よって署名は **別フィールド（session_proof）** で運ぶ。
 */

/** 前後の空白を落とす。理由は sync-auth.ts の normalizeSecret と同じ（改行 1 文字事故）。 */
function normalizeSecret(value: string): string {
  return value.trim();
}

/**
 * 長さと内容を、**入力に依存しない時間で**突き合わせる。
 * （`===` は最初の不一致で打ち切るため、どこまで合っていたかを時間で漏らす）
 */
function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** ArrayBuffer を base64url にする（Workers に Buffer は無い）。 */
function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** session_id に対する proof を計算する（テストと web-app との突き合わせにも使う）。 */
export async function signSessionId(sessionId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(normalizeSecret(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionId));
  return toBase64Url(sig);
}

/**
 * `session_proof` が `session_id` の正しい署名かを判定する。**決して throw しない。**
 *
 * fail-closed:
 *   - secret 未設定 / 空白のみ → false（誤設定で無検証開放しない）
 *   - proof 未指定 → false
 *   - 計算に失敗 → false
 */
export async function verifySessionProof(
  sessionId: string,
  proof: string | null | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || normalizeSecret(secret) === "") return false;
  if (!proof) return false;

  try {
    const expected = await signSessionId(sessionId, secret);
    return constantTimeEquals(normalizeSecret(proof), expected);
  } catch (err) {
    console.warn(
      "[chat-session] proof verification failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * この呼び出しで **session_id を鍵として使ってよいか** を決める。
 *
 * 使ってよいのは「サーバ経由（X-API-Key 検証済み）**かつ** 署名が正しい」ときだけ。
 * どちらか欠けたら、その session_id は **一切使わない**（読みにも書きにも identity にも）。
 *
 * ─ なぜ 400 で突き返さないのか（意図的な設計判断）─
 *
 *   「拒否」の実装として最も素直なのは 400 を返すことだが、それだと
 *   **共有秘密が片側だけずれた瞬間にチャットが全面停止する**。このリポジトリでは
 *   実際に 2026-08-30、共有鍵の末尾改行 1 文字で連携が全滅している（commit 7d0118d
 *   「共有鍵の比較を両側 trim にし、改行 1 文字で連携が全滅する経路を塞ぐ」）。
 *   同じ形の落とし穴を、今度は会話そのものの可用性に対して作ることになる。
 *
 *   代わりに **その場限りの session を発行して応答は続ける**。攻撃者が他人の
 *   session_id を名乗っても、鍵として使われるのは自分専用の使い捨て ID なので
 *   P1/P2/P3 はいずれも成立しない（データ面は完全に fail-closed）。鍵の事故が
 *   起きたときの症状は「チャットが会話を覚えていない」という**目に見える劣化**に
 *   留まり、全面停止にはならない。どちらの壊れ方も 1 行ログで数えられる。
 */
export async function resolveUsableSessionId(input: {
  /** ブラウザ／proxy が名乗ってきた session_id。 */
  claimedSessionId: string;
  /** その署名。 */
  proof: string | null | undefined;
  /** X-API-Key 検証済みのサーバ間呼び出しか。 */
  trusted: boolean;
  /** Worker 側の共有秘密。 */
  secret: string | undefined;
  /** 使い捨て ID の発行（テストから差し替えられるようにしておく）。 */
  mintEphemeral?: () => string;
}): Promise<{ sessionId: string; proven: boolean; reason?: string }> {
  const { claimedSessionId, proof, trusted, secret } = input;
  const mint = input.mintEphemeral ?? (() => crypto.randomUUID());

  if (!trusted) {
    return { sessionId: mint(), proven: false, reason: "untrusted_caller" };
  }
  if (!secret || normalizeSecret(secret) === "") {
    // 設定事故。**無検証で通さない**が、応答は止めない。
    return { sessionId: mint(), proven: false, reason: "secret_unset" };
  }
  if (!(await verifySessionProof(claimedSessionId, proof, secret))) {
    return { sessionId: mint(), proven: false, reason: proof ? "proof_mismatch" : "proof_absent" };
  }
  return { sessionId: claimedSessionId, proven: true };
}
