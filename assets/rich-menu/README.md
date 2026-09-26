# Rich Menu Assets

LINE リッチメニューの背景画像。枠・言葉・行き先の正本は `scripts/lib/rich-menu-definition.ts`、
反映と戻し方は `docs/deploy-runbook.md`「リッチメニューの差し替えと戻し方」。

## 今のメニュー: 仮メニュー 3 枠・Amazon（2026-09-26〜）

- `richmenu-temp-3slot-amazon.png` — **現役**。2500×843・1 段 3 列（833 / 833 / 834）。
  ① お茶の淹れ方 | ② 好み診断 | ③ Amazon ストア。`pnpm setup-rich-menu` が既定でこのファイルを使う。
  - 出所: デザイン QA（elxea-qa）を通った r1a・3 列版（49,915 バイト / sha256 `87b11129e8045e48…`）。
  - **Setaka の最終確認前**。③ のアイコンなどが差し替わるときは、このファイルを**同じ名前で置き換えるだけ**でよい
    （コードと手順書は変えなくてよい）。置き換えた画像が PNG・2500×843・1,000,000 バイト以下であることは
    `npx tsx tests/unit/rich-menu-definition.test.ts` が確かめる。
  - 画像ファイルはグローバルの gitignore に当たるので、コミットは `git add -f assets/rich-menu/richmenu-temp-3slot-amazon.png`。

## 以前のメニュー: 6 枠 Option A（2500×1686）

LINE 上では名前の違う別メニュー（`elxea メインメニュー（6 枠 Option A）`）として残っていて、
`pnpm setup-rich-menu -- --channel prod --set-default <旧ID> --stateless` で既定に戻せる。
以下は当時の背景のレンダリング元（画像ファイルはリポジトリに入っていない）。

- `richmenu-optionA-6slot-bigger.html` / `render.mjs` — 6 枠の背景のレンダリング元（`node assets/rich-menu/render.mjs`、playwright が要る）
- `smaller-review/` — 文字を小さくした版（14dp / 12dp）のレンダリング元
- 経緯: 2026-07-20 テスト OA に大きい文字の版 / 2026-07-21 12dp 版（`richmenu-56c4ed49df58f999c31d01ad5b803f9c`）/
  2026-08-10 本番は roji 導線入りの 6 枠（`richmenu-4383dd8074a470e13a19bf2463ef8ee3`。`docs/deploy-runbook.md` に記録）
