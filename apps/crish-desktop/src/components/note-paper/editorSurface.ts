/**
 * 编辑呈现面常量（W5-A / A-SURF-01）
 *
 * 桌面入口：re-export `@crish/block-paper-contract`。
 * 对外保留 `EDITOR_SURFACE_*` 别名（= 契约 `SURFACE_*`），避免改遍调用方。
 * 禁止本文件再写死 `'chat' | 'note-paper'` 字面量。
 * surface 单源 ≠ 打开完成 ≠ 关 EL ≠ 独立软件已拆。
 */

import {
  EDITOR_SURFACES,
  SURFACE_CHAT,
  SURFACE_NOTE_PAPER,
  type EditorSurface,
} from '@crish/block-paper-contract';

export type { EditorSurface };
export { EDITOR_SURFACES, SURFACE_CHAT, SURFACE_NOTE_PAPER };

/** 契约 `SURFACE_CHAT` 的桌面别名 */
export const EDITOR_SURFACE_CHAT = SURFACE_CHAT;

/** 契约 `SURFACE_NOTE_PAPER` 的桌面别名 */
export const EDITOR_SURFACE_NOTE_PAPER = SURFACE_NOTE_PAPER;

export function isEditorSurface(value: unknown): value is EditorSurface {
  return value === SURFACE_CHAT || value === SURFACE_NOTE_PAPER;
}
