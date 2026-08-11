/**
 * 编辑呈现面常量（W5-A / A-SURF-01）
 *
 * 本地定义，避免阻塞 `@crish/block-paper-contract` 并行合并。
 * 仅允许 `chat` | `note-paper` 两个 surface；禁止第三权威面。
 */

export const EDITOR_SURFACE_CHAT = 'chat' as const;
export const EDITOR_SURFACE_NOTE_PAPER = 'note-paper' as const;

/** 编辑呈现面；禁止用 string 魔法值串门 */
export type EditorSurface =
  typeof EDITOR_SURFACE_CHAT | typeof EDITOR_SURFACE_NOTE_PAPER;

export const EDITOR_SURFACES: readonly EditorSurface[] = [
  EDITOR_SURFACE_CHAT,
  EDITOR_SURFACE_NOTE_PAPER,
] as const;

export function isEditorSurface(value: unknown): value is EditorSurface {
  return value === EDITOR_SURFACE_CHAT || value === EDITOR_SURFACE_NOTE_PAPER;
}
