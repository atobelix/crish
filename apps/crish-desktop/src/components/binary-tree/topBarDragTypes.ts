/**
 * useTopBarDrag 拖拽源与画布 leaf 命中类型。
 * 从 useTopBarDrag.ts 抽出；语义见壳 hook 注释。
 */
import type { Rect } from '../../store/types';

/** 拖拽源类型（会话标签 / 功能标签） */
export type TopBarDragSource =
  | { kind: 'session'; sessionId: string; title: string }
  | { kind: 'tool'; leafId: string; tabId: string; panelId: string; title: string };

/** 画布 leaf 命中条目（拖拽开始时一次性收集） */
export interface LeafRectItem {
  id: string;
  panelId: string;
  tabCount: number;
  rect: Rect;
}
