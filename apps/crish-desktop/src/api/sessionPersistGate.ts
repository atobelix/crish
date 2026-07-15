/**
 * 会话持久化门禁：仅当会话域（sessions / activeSessionId / folderOrder）变化时
 * 才应调度 localStorage 与磁盘镜像写入。遥测等字段变更不得触发落盘。
 */

export type SessionDomainSlice = {
  sessions: unknown;
  activeSessionId: string;
  folderOrder: unknown;
};

/**
 * 比较两份会话域切片。优先引用相等（immer 下未改 sessions 时引用稳定）。
 * @returns true = 会话域有变，应调度 persist
 */
export function sessionDomainChanged(
  prev: SessionDomainSlice | null | undefined,
  next: SessionDomainSlice,
): boolean {
  if (!prev) return true;
  if (prev.sessions !== next.sessions) return true;
  if (prev.activeSessionId !== next.activeSessionId) return true;
  if (prev.folderOrder !== next.folderOrder) return true;
  return false;
}

/** 从任意 store 快照抽出会话域字段（缺省空串 / 空数组语义由调用方保证） */
export function pickSessionDomain(state: {
  sessions: unknown;
  activeSessionId?: string | null;
  folderOrder?: unknown;
}): SessionDomainSlice {
  return {
    sessions: state.sessions,
    activeSessionId: state.activeSessionId || '',
    folderOrder: state.folderOrder,
  };
}
