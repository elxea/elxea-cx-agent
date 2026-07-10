/**
 * 画像取込（Notion files 一時URL → R2 → 恒久公開URL）。
 *
 * 設計: 「Notion駆動 LINE配信」非エンジニア化。運用者は Notion の files 型「画像」
 *   プロパティに画像をドラッグ&ドロップする。システムは承認 pin 時にその一時URL
 *   （Notion 署名・約1時間で失効）から取得し、R2（配信用）へ put して恒久公開URL化する。
 *   送信側はこの恒久URL群（決定的に再構成可能）を使う。
 *
 * R2 アクセスは Cloudflare API v4 + fetch + Bearer 方式（Worker 互換・aws-sdk 不使用）。
 *   agents/elxea-broadcaster/src/lib/r2-client.ts の方式を移植した。
 *
 * ⚠ 実送信の絶対制約:
 *   このモジュールは R2 への put と URL 生成のみを行い、LINE 送信 API は一切叩かない。
 *
 * 画像正規化（HEIC 変換 / 4096px / 10MB）は最小実装:
 *   put 前にサイズ・content-type をチェックし、超過/非対応は warning として報告する。
 *   正規化本体（実変換）は次段タスク（v2）とする（Worker 上の重変換は別途）。
 */

/** R2 の設定（put に必要な資格情報を含む）。 */
export interface R2Config {
  accountId: string;
  apiToken: string;
  bucket: string;
  /** 公開ベースURL（例: https://pub-xxxx.r2.dev）。末尾スラッシュは除去して保持。 */
  publicBase: string;
}

/** R2 バケット既定（elxea-broadcaster と共通の画像バケット）。 */
const DEFAULT_BUCKET = "elxea-images";
/** R2 公開ベース既定（未設定時のフォールバック）。 */
const DEFAULT_PUBLIC_BASE = "https://pub-90a0485599904fee8228ef56bb51c2e6.r2.dev";

/** LINE image メッセージの上限（10MB）。超過は warning（正規化は次段）。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** env（Workers Bindings / process.env 互換）から R2 設定名を読む型。 */
export interface R2EnvLike {
  R2_ACCOUNT_ID?: string;
  R2_API_TOKEN?: string;
  R2_BUCKET_NAME?: string;
  R2_PUBLIC_BASE?: string;
}

/** 末尾スラッシュ除去。 */
function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * put に必要な R2 設定を解決する（資格情報必須・fail-closed）。
 * 承認 pin（アップロード）時にのみ使う。送信側の URL 再構成は resolveR2PublicBase で足りる。
 */
export function resolveR2Config(env: R2EnvLike): R2Config {
  const accountId = env.R2_ACCOUNT_ID;
  const apiToken = env.R2_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("R2_ACCOUNT_ID and R2_API_TOKEN must be set");
  }
  return {
    accountId,
    apiToken,
    bucket: env.R2_BUCKET_NAME || DEFAULT_BUCKET,
    publicBase: trimTrailingSlash(env.R2_PUBLIC_BASE || DEFAULT_PUBLIC_BASE),
  };
}

/**
 * 公開ベースURLのみを解決する（資格情報不要）。
 * 送信時の URL 再構成（r2UrlsForPage）に使う。R2 token 未設定でも送信側は動く
 * （送信は既存 R2 オブジェクトを参照するだけで、put しないため）。
 */
export function resolveR2PublicBase(env: R2EnvLike): string {
  return trimTrailingSlash(env.R2_PUBLIC_BASE || DEFAULT_PUBLIC_BASE);
}

/** 配信画像の R2 キー（spec: broadcast/<page_id>/<index>.jpg）。 */
export function r2KeyForImage(pageId: string, index: number): string {
  return `broadcast/${pageId}/${index}.jpg`;
}

/** R2 キーから恒久公開URLを生成。 */
export function r2PublicUrl(publicBase: string, key: string): string {
  return `${trimTrailingSlash(publicBase)}/${key}`;
}

/**
 * ページの画像枚数から恒久R2公開URL群を「決定的に」生成する（純粋）。
 *
 * キーが broadcast/<page_id>/<index>.jpg で決定的なため、送信時は枚数さえ分かれば
 * pin 時と同じ URL 群を再構成できる（Notion に URL を保存しなくてよい）。
 * これによりコンテンツハッシュ照合（TOCTOU）が pin 時と送信時で一致する。
 */
export function r2UrlsForPage(
  pageId: string,
  count: number,
  publicBase: string,
): string[] {
  const base = trimTrailingSlash(publicBase);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(r2PublicUrl(base, r2KeyForImage(pageId, i)));
  }
  return out;
}

/** R2 に 1 オブジェクトを PUT する（Cloudflare API v4・fetch 注入可）。 */
export async function putToR2(
  cfg: R2Config,
  key: string,
  body: Uint8Array,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const encodedKey = key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${cfg.bucket}/objects/${encodedKey}`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      "Content-Type": contentType,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 put failed for ${key}: ${res.status} ${text.slice(0, 200)}`);
  }
}

/**
 * 配信をブロックする画像問題の分類（fail-closed 用）。
 * - unsupported_format: image/* だが LINE 非対応（HEIC 等・JPEG/PNG 以外）
 * - not_image: content-type が image/* でない
 * - oversize: LINE image 上限（10MB）超過
 * index は 0 始まり（運用者向け表示は describeBlockingImages で 1 始まりに変換する）。
 */
export interface BlockingImageIssue {
  index: number;
  kind: "unsupported_format" | "not_image" | "oversize";
  /** 表示用の付帯情報（content-type 等・PII 非記載）。 */
  detail: string;
}

/** ingest の結果。 */
export interface IngestResult {
  /** 恒久 R2 公開URL（Notion files の順序を保持）。 */
  urls: string[];
  /** サイズ/形式の逸脱など、運用者/次段タスクに伝える警告（PII 非記載）。 */
  warnings: string[];
  /**
   * 配信をブロックすべき画像問題（HEIC 等の LINE 非対応形式・非画像・10MB超）。
   * 1 件でもあれば承認 pin を fail-closed する（壊れた画像が届く前に止める）。
   * 空なら送信可（従来挙動）。warnings とは別に「止める根拠」を構造化して返す。
   */
  blocking: BlockingImageIssue[];
}

/**
 * blocking 問題群を運用者向けの平易な日本語 1 文にする（純粋・PII 非記載）。
 * 画像番号は 1 始まり（運用者が Notion で見る順）。
 */
export function describeBlockingImages(blocking: BlockingImageIssue[]): string {
  if (blocking.length === 0) return "";
  const parts = blocking.map((b) => {
    const n = b.index + 1;
    if (b.kind === "unsupported_format") {
      return `画像${n}がLINEで表示できない形式です（${b.detail}）。JPEG か PNG にしてください。`;
    }
    if (b.kind === "not_image") {
      return `画像${n}が画像ファイルではありません（${b.detail}）。JPEG か PNG の画像にしてください。`;
    }
    return `画像${n}のサイズが大きすぎます（${b.detail}）。10MB 以下に縮小してください。`;
  });
  return parts.join(" ");
}

/**
 * Notion files の一時URL群を順番に取得して R2 に put し、恒久URL群を返す。
 *
 * - 順序は sourceUrls の配列順を厳密に保持（LINE の画像表示順に一致）。
 * - キーは決定的（broadcast/<pageId>/<index>.jpg）。同 page+index への put は
 *   決定的な上書き（冪等）。再承認時は現行画像で上書きする。
 * - 正規化は最小: content-type が image/* でない / 10MB 超過は warning に積むが
 *   put は行う（配信可否は buildMessages / LINE 側で最終判定。実変換は v2）。
 *
 * ⚠ LINE 送信は行わない。R2 put のみ。fetch は注入可能（テストはネットワーク非接触）。
 */
export async function ingestPageImages(
  cfg: R2Config,
  pageId: string,
  sourceUrls: string[],
  deps?: { fetchImpl?: typeof fetch },
): Promise<IngestResult> {
  const f = deps?.fetchImpl ?? fetch;
  const urls: string[] = [];
  const warnings: string[] = [];
  const blocking: BlockingImageIssue[] = [];

  for (let i = 0; i < sourceUrls.length; i++) {
    const src = sourceUrls[i];
    const r = await f(src);
    if (!r.ok) {
      throw new Error(`image fetch failed [#${i}]: ${r.status}`);
    }
    const rawCt = r.headers.get("content-type") || "application/octet-stream";
    const ct = rawCt.split(";")[0].trim().toLowerCase();
    const buf = new Uint8Array(await r.arrayBuffer());

    // 最小正規化チェック（実変換は次段 v2）。逸脱は warning（従来）に加え、
    // 配信をブロックすべきもの（LINE 非対応形式・非画像・10MB超）は blocking にも積む。
    const isImage = ct.startsWith("image/");
    const isLineSafe = ct === "image/jpeg" || ct === "image/png";
    if (!isImage) {
      warnings.push(`#${i} content-type が画像でない（${ct}）`);
      blocking.push({ index: i, kind: "not_image", detail: ct });
    } else if (!isLineSafe) {
      // HEIC 等。LINE は JPEG/PNG のみ表示可。次段で変換する（今は fail-closed で止める）。
      warnings.push(`#${i} LINE 非対応形式（${ct}）— JPEG/PNG 変換が必要（次段 v2）`);
      blocking.push({ index: i, kind: "unsupported_format", detail: ct });
    }
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      warnings.push(
        `#${i} サイズ超過（${buf.byteLength} bytes > 10MB）— 縮小が必要（次段 v2）`,
      );
      blocking.push({
        index: i,
        kind: "oversize",
        detail: `${(buf.byteLength / (1024 * 1024)).toFixed(1)}MB`,
      });
    }

    const key = r2KeyForImage(pageId, i);
    // 保存 content-type は元が画像ならそのまま、そうでなければ jpeg 扱い。
    await putToR2(cfg, key, buf, isImage ? ct : "image/jpeg", f);
    urls.push(r2PublicUrl(cfg.publicBase, key));
  }

  return { urls, warnings, blocking };
}
