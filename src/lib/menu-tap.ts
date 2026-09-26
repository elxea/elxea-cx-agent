/**
 * menu.tap 判定（P0-1）— メニュー由来の 5 つのトリガー文言の話しかけを flow_events に記録するための純粋写像。
 *
 * 設計: 統合設計書 §B-5a（menu.tap: トリガー文言の完全一致判定直後 / value=brew/diagnosis/consult/subscription/about）
 *
 * 5 つのトリガー文言（旧 5 枠メニューの message text。いまの仮メニュー 3 枠の ①② は
 * scripts/lib/rich-menu-definition.ts の message text と一致）を value スラッグへ写す。
 * 完全一致のみ（自由発話・サブトークン `淹れ方｜…` `診断｜…` 等は対象外）。無関係発話は null。
 * これで棚卸しの H4（枠別タップ分布）が検証可能になる。
 */

import {
  CONSULTATION_TRIGGER,
  SUBSCRIPTION_TRIGGER,
  ABOUT_TRIGGER,
} from "./menu-actions";
import { DIAGNOSIS_TRIGGER } from "./preference-diagnosis";

/**
 * ①淹れ方のリッチメニュー入口（2026-07-13 確定・仮メニュー 3 枠でも同じ文言）。
 * tea-menu.ts の ENTRY_PHRASES に含まれる代表トリガー。メニュー側の値は scripts/lib/rich-menu-definition.ts の
 * BREW_MENU_TEXT で、一致は tests/unit/rich-menu-definition.test.ts が固定する。
 * （tea-menu.ts の Set は module-private のため、代表値をここに定義。旧文言は tea-menu が別途吸収する）。
 */
export const BREW_RICH_MENU_TRIGGER = "お茶の淹れ方を知りたい";

/** menu.tap の value スラッグ。 */
export type MenuTapValue =
  | "brew"
  | "diagnosis"
  | "consult"
  | "subscription"
  | "about";

/**
 * トリガー文言 → value スラッグ（完全一致）。
 *
 * 注意（2026-09-26）: メニューは仮の 3 枠（① お茶の淹れ方 / ② 好み診断 / ③ Amazon ストア）。①② は
 * brew / diagnosis として記録される。③ は uri アクションで、押してもメッセージが来ないので menu.tap には
 * 載らない（押された回数は Worker の /go/store で数える。実装設計 rev2 第7章）。store は足さない。
 * （経緯: 2026-08-10〜09-26 の 6 枠では ③マイカルテ / ⑤読みもの / ⑥roji アンケートが記録されない欠測があった。）
 * consult / about は枠を持たない発話専用トリガーになったが、発話としては来るため写像は残す。
 * MenuTapValue の拡張は flow_events の集計スキーマに影響するため別タスクで扱う。
 */
const MENU_TRIGGERS: Record<string, MenuTapValue> = {
  [BREW_RICH_MENU_TRIGGER]: "brew",
  [DIAGNOSIS_TRIGGER]: "diagnosis",
  [CONSULTATION_TRIGGER]: "consult",
  [SUBSCRIPTION_TRIGGER]: "subscription",
  [ABOUT_TRIGGER]: "about",
};

/**
 * 発話が 5 つのトリガー文言のいずれかと完全一致なら value スラッグを返す（純粋）。
 * それ以外（サブトークン・自由発話）は null。
 */
export function menuTapValue(userMessage: string): MenuTapValue | null {
  return MENU_TRIGGERS[userMessage.trim()] ?? null;
}
