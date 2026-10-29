/**
 * 会话持久化门禁：仅当会话域（sessionsById / sessionOrder / activeSessionId / folderOrder）变化时
 * 才应调度 localStorage 与磁盘镜像写入。遥测等字段变更不得触发落盘。
 * 正文修改换 sessionsById 引用，仅重排换 sessionOrder 引用，两者都要落盘。
 */

export type SessionDomainSlice = {
  sessionsById: unknown;
  sessionOrder: unknown;
  activeSessionId: string;
  folderOrder: unknown;
};

/**
 * 比较两份会话域切片。优先引用相等（immer 下未改索引时引用稳定）。
 * @returns true = 会话域有变，应调度 persist
 */
export function sessionDomainChanged(
  prev: SessionDomainSlice | null | undefined,
  next: SessionDomainSlice,
): boolean {
  if (!prev) return true;
  if (prev.sessionsById !== next.sessionsById) return true;
  if (prev.sessionOrder !== next.sessionOrder) return true;
  if (prev.activeSessionId !== next.activeSessionId) return true;
  if (prev.folderOrder !== next.folderOrder) return true;
  return false;
}

/** 从任意 store 快照抽出会话域字段（缺省空串 / 空数组语义由调用方保证） */
export function pickSessionDomain(state: {
  sessionsById: unknown;
  sessionOrder: unknown;
  activeSessionId?: string | null;
  folderOrder?: unknown;
}): SessionDomainSlice {
  return {
    sessionsById: state.sessionsById,
    sessionOrder: state.sessionOrder,
    activeSessionId: state.activeSessionId || '',
    folderOrder: state.folderOrder,
  };
}
