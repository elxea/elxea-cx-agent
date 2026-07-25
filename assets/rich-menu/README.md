# Rich Menu Assets — 6-slot Option A (bigger label)

Background image for the elxea LINE rich menu. Layout SoT for areas/actions is
`scripts/setup-rich-menu.ts` (6 枠 2×3, 833/833/834 × 843×2).

## Files
- `richmenu-optionA-6slot-xs12-final.png` — **CURRENT live background on the TEST OA** (label 77px = 12dp on 390dp; icon disc 280px / glyph 132px; icon→label gap 80px). Render source: `smaller-review/richmenu-optionA-6slot-xs12-final.html` via `smaller-review/render-xs12-final.mjs`.
- `richmenu-optionA-6slot-sm14-final.png` — previous live version (label 90px = 14dp, gap 80px). Superseded 2026-07-21.
- `richmenu-optionA-6slot-bigger.html` — earlier render source (2500×1686, quiet two-tone beige).
- `richmenu-optionA-6slot-bigger.png` — earlier rendered background (label 105px ≈ 16.4dp; icon disc 280px / glyph 132px).
- `render.mjs` — regenerate the `bigger` PNG from the HTML (`node assets/rich-menu/render.mjs`, requires playwright).

## Layout (matches setup-rich-menu.ts)
```
上段: お茶の淹れ方 | 好み診断 | マイカルテ
下段: 定期便       | 読みもの | elxea について
```

## Apply (structure + image + set default)
```bash
export LINE_CHANNEL_ACCESS_TOKEN_TEST=...   # test OA @426vlcyb (staging)
export RICH_MENU_IMAGE_PATH="$PWD/assets/rich-menu/richmenu-optionA-6slot-xs12-final.png"
pnpm setup-rich-menu
```
`setup-rich-menu.ts` prefers `*_TEST` (fail-safe: never touches prod `@307tzhkw`
unless the TEST token is unset and `LINE_CHANNEL_ACCESS_TOKEN` is exported).

## History
- 2026-07-20: replaced the smaller-label Option A with this bigger-label version on the TEST OA (@426vlcyb).
- 2026-07-21: shrank label 14dp/90px → 12dp/77px while KEEPING the widened 80px icon→label gap; applied to TEST OA (@426vlcyb). New richMenuId `richmenu-56c4ed49df58f999c31d01ad5b803f9c` (superseded `richmenu-76645d101017ecc6643baac2d0f4be0d`, deleted). Asset: `richmenu-optionA-6slot-xs12-final.png`.
