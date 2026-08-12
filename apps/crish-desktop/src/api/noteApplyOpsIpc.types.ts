/**
 * 笔记 apply_ops IPC 类型与命令名（SD-34 切开 · types）
 *
 * **≠ EL-01**；**≠ EL-08**；切开 ≠ 关账。
 * 无 Tauri 不得默认可写（见 adapt / resolve）。
 */

/** Tauri / 前端 IPC：collab wire JSON → DocSession::apply */
export const NOTE_CMD_APPLY_OPS = 'note_apply_ops' as const;

/** 前端 camelCase 请求 */
export type NoteApplyOpsRequest = {
  docId: string;
  /** collab Op 数组 JSON 字符串（createCollabApplySink wire 形状） */
  opsJson: string;
  /** 幂等 / 审计键（ApplyOpsAdapter meta.intentId） */
  intentId?: string;
  /** user | agent | remote | system；默认 user */
  origin?: string;
};

export type NoteApplyOpsIpcSuccess = {
  ok: true;
  docId: string;
  rev: number;
  applied: number;
  /** 专用 apply_ops 成功时恒为 tauri-ipc（≠ mock 伪装生产） */
  source: 'tauri-ipc';
  intentId?: string;
};

export type NoteApplyOpsIpcFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type NoteApplyOpsIpcOutcome =
  NoteApplyOpsIpcSuccess | NoteApplyOpsIpcFailure;

/**
 * 可注入 apply_ops IPC 面（mock / Tauri）。
 * 产品 Strict 在可检测 Tauri 时经 `resolveProductStrictApplyOps` 默认走此面；
 * **无 Tauri 不得** 静默 mock 可写。
 */
export type NoteApplyOpsIpc = {
  applyOps(req: NoteApplyOpsRequest): Promise<NoteApplyOpsIpcOutcome>;
};
