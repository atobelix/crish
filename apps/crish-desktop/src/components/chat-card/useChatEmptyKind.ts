import { useEffect, useMemo, useState } from 'react';
import { isDemoMode } from '../../api/appMode';
import {
  chatEmptyKindAriaLabel,
  resolveChatEmptyKind,
} from '../../api/chatEmptyState';
import { isPendingDraft } from '../../store/storeAccess';

export interface UseChatEmptyKindOptions {
  activeSessionId: string | null;
  messageCount?: number;
  displayCount?: number;
  localMsgFilter: string;
  mainSurface: string;
  hydratedFromEngine: boolean | undefined;
  engineCursor: number | undefined;
  engineLastRunId: string | undefined;
  messagesHydrated?: boolean;
}

export function useChatEmptyKind({
  activeSessionId,
  messageCount: messageCountProp,
  displayCount: displayCountProp,
  localMsgFilter,
  mainSurface,
  hydratedFromEngine,
  engineCursor,
  engineLastRunId,
  messagesHydrated,
}: UseChatEmptyKindOptions) {
  const [hydrateTimedOut, setHydrateTimedOut] = useState(false);

  useEffect(() => {
    setHydrateTimedOut(false);
  }, [activeSessionId]);

  const messageCount = messageCountProp ?? 0;
  const displayCount = displayCountProp ?? messageCount;

  const messagesLoadingCandidate = useMemo(() => {
    if (isDemoMode()) return false;
    if (!activeSessionId) return false;
    // 草稿态（点击"新对话"后的虚拟会话）：不进入 loading 等待。
    // 草稿态本就是 0 消息的预期状态，无需等待引擎水合，直接显示 session-empty 欢迎面。
    if (isPendingDraft(activeSessionId)) return false;
    if (messageCount > 0) return false;
    // 历史会话懒壳尚未完成 SQLite 水合：必须判定为 loading，绝不提前闪烁欢迎面
    if (messagesHydrated === false) return true;
    if (hydratedFromEngine === true) return false;
    // hydratedFromEngine !== false（含 undefined）：旧本地会话 / 未挂引擎游标时
    // 不长期挡空态。仅当引擎明确 hydratedFromEngine===false 时才进入 loading。
    if (hydratedFromEngine !== false) {
      if (typeof engineCursor !== 'number' && !engineLastRunId) {
        return false;
      }
    }
    const isLocalMintId = /^sess-(branch-)?\d+$/i.test(activeSessionId);
    if (isLocalMintId && typeof engineCursor !== 'number' && !engineLastRunId) {
      return false;
    }
    return true;
  }, [
    activeSessionId,
    messageCount,
    messagesHydrated,
    hydratedFromEngine,
    engineCursor,
    engineLastRunId,
  ]);

  useEffect(() => {
    if (!messagesLoadingCandidate) {
      setHydrateTimedOut(false);
      return;
    }
    setHydrateTimedOut(false);
    const t = window.setTimeout(() => setHydrateTimedOut(true), 3000);
    return () => window.clearTimeout(t);
  }, [activeSessionId, messagesLoadingCandidate]);

  const messagesLoading = messagesLoadingCandidate && !hydrateTimedOut;

  // 历史会话从 SQLite 水合正文期间（messagesHydrated === false 且非草稿），静默等待，严禁呈现 session-empty 幽灵闪现
  const isLazyHydrating =
    messagesHydrated === false &&
    Boolean(activeSessionId) &&
    !isPendingDraft(activeSessionId) &&
    !hydrateTimedOut;

  const resolvedEmptyKind = resolveChatEmptyKind({
    hasActiveSession: Boolean(activeSessionId),
    messageCount,
    displayCount,
    filterQuery: localMsgFilter,
    mainSurface:
      mainSurface === 'scheduled'
        ? 'scheduled'
        : mainSurface === 'chat'
          ? 'chat'
          : undefined,
    // 不把 messagesLoading 传给 resolve：loading 不得灭 emptyKind
  });

  const emptyKind = isLazyHydrating ? null : resolvedEmptyKind;
  const onEmptySurface = emptyKind != null;

  const chatRegionAria =
    mainSurface === 'scheduled'
      ? '定时任务'
      : emptyKind
        ? chatEmptyKindAriaLabel(emptyKind)
        : messagesLoading
          ? '正在加载会话消息'
          : '对话主区';

  return {
    messagesLoading,
    emptyKind,
    onEmptySurface,
    chatRegionAria,
  };
}
