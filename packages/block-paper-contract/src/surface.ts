/**
 * 双引擎 EditorSurface 与跨面桥接 Intent 契约。
 *
 * 对齐：`docs/block-workspace-architecture/plans/specs/dual-engine-surface.md`
 * - §1.1 枚举契约（A-SURF-01）
 * - §3 禁止共享（NS-01…NS-07）
 * - §5.2.1 SendToNoteIntent
 *
 * 仅类型与常量；不接线业务 store。
 */

// ---------------------------------------------------------------------------
// EditorSurface（A-SURF-01）
// ---------------------------------------------------------------------------

/**
 * 编辑呈现面；禁止用 string 魔法值串门。
 * 仅两个 surface：`chat`（行级流式）| `note-paper`（块纸面）。
 */
export type EditorSurface = 'chat' | 'note-paper';

/** 运行时可枚举的 surface 全集（顺序稳定，便于断言） */
export const EDITOR_SURFACES = ['chat', 'note-paper'] as const;

/** 与 `EDITOR_SURFACES` 元素等价的字面量联合 */
export type EditorSurfaceId = (typeof EDITOR_SURFACES)[number];

/** surface=chat 标注常量（模块入口可用） */
export const SURFACE_CHAT = 'chat' as const satisfies EditorSurface;

/** surface=note-paper 标注常量（模块入口可用） */
export const SURFACE_NOTE_PAPER = 'note-paper' as const satisfies EditorSurface;

// ---------------------------------------------------------------------------
// SendToNoteIntent（§5.2.1）
// ---------------------------------------------------------------------------

/** 桥接写入目标模式 */
export type SendToNoteMode =
  'insert_blocks' | 'apply_md_fragment' | 'append_to_block';

/**
 * surface=chat 完成态 → 请求写入 note-paper。
 *
 * 不变量：
 * - **不得**隐式触发（须用户或 Agent 显式发出）
 * - `source.markdown` 为发送瞬间 MD **快照**；禁止持有 `lines[]` 引用过桥
 * - 失败时块树零变化；同 `intentId` 幂等
 */
export type SendToNoteIntent = {
  type: 'send_to_note';
  /** 幂等键 */
  intentId: string;
  source: {
    surface: 'chat';
    messageId: string;
    /**
     * 发送瞬间的 MD 快照。
     * // A-SURF：禁止持有 lines[] 引用过桥
     */
    markdown: string;
  };
  target: {
    surface: 'note-paper';
    docId: string;
    /** 插入点：父块 */
    parentId?: string;
    /** 插入点：位次（在此块之后） */
    afterBlockId?: string;
    mode: SendToNoteMode;
  };
  origin: 'user' | 'agent';
};

/** 类型守卫：窄化未知载荷为 SendToNoteIntent 形状（浅校验） */
export function isSendToNoteIntent(value: unknown): value is SendToNoteIntent {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type !== 'send_to_note') return false;
  if (typeof v.intentId !== 'string' || v.intentId.length === 0) return false;
  if (v.origin !== 'user' && v.origin !== 'agent') return false;

  const source = v.source;
  if (source === null || typeof source !== 'object') return false;
  const s = source as Record<string, unknown>;
  if (s.surface !== 'chat') return false;
  if (typeof s.messageId !== 'string') return false;
  if (typeof s.markdown !== 'string') return false;

  const target = v.target;
  if (target === null || typeof target !== 'object') return false;
  const t = target as Record<string, unknown>;
  if (t.surface !== 'note-paper') return false;
  if (typeof t.docId !== 'string') return false;
  const modes: SendToNoteMode[] = [
    'insert_blocks',
    'apply_md_fragment',
    'append_to_block',
  ];
  if (typeof t.mode !== 'string' || !modes.includes(t.mode as SendToNoteMode)) {
    return false;
  }
  return true;
}
