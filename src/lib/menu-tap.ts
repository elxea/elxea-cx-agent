/**
 * menu.tap 判定（P0-1）— リッチメニュー 5 枠のタップを flow_events に記録するための純粋写像。
 *
 * 設計: 統合設計書 §B-5a（menu.tap: 5枠トリガー文言の完全一致判定直後 / value=brew/diagnosis/consult/subscription/about）
 *
 * 5 枠のトリガー文言（setup-rich-menu.ts の message text と一致）を value スラッグへ写す。
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
 * ①淹れ方のリッチメニュー入口（5 枠版・2026-07-13 確定）。
 * tea-menu.ts の ENTRY_PHRASES に含まれる代表トリガー。値は setup-rich-menu.ts が SoT。
 * （tea-menu.ts の Set は module-private のため、5 枠代表値をここに定義。旧文言は tea-menu が別途吸収する）。
 */
export const BREW_RICH_MENU_TRIGGER = "お茶の淹れ方を知りたい";

/** menu.tap の value スラッグ。 */
export type MenuTapValue =
  | "brew"
  | "diagnosis"
  | "consult"
  | "subscription"
  | "about";

/** 5 枠トリガー文言 → value スラッグ（完全一致）。 */
const MENU_TRIGGERS: Record<string, MenuTapValue> = {
  [BREW_RICH_MENU_TRIGGER]: "brew",
  [DIAGNOSIS_TRIGGER]: "diagnosis",
  [CONSULTATION_TRIGGER]: "consult",
  [SUBSCRIPTION_TRIGGER]: "subscription",
  [ABOUT_TRIGGER]: "about",
};

/**
 * 発話が 5 枠のいずれかのトリガー完全一致なら value スラッグを返す（純粋）。
 * それ以外（サブトークン・自由発話）は null。
 */
export function menuTapValue(userMessage: string): MenuTapValue | null {
  return MENU_TRIGGERS[userMessage.trim()] ?? null;
}
