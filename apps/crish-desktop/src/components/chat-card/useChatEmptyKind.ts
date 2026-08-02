import { useEffect, useMemo, useState } from 'react';
import type { SessionMessage } from '../../store/layoutStore';
import { isDemoMode } from '../../api/appMode';
import { messageMatchesSearch } from '../../api/sessionSearch';
import {
  chatEmptyKindAriaLabel,
  resolveChatEmptyKind,
} from '../../api/chatEmptyState';
import { isPendingDraft } from '../../api/store-access/componentAccess';

export interface UseChatEmptyKindOptions {
  activeSessionId: string | null;
  messages: SessionMessage[];
  localMsgFilter: string;
  mainSurface: string;
  hydratedFromEngine: boolean | undefined;
  engineCursor: number | undefined;
  engineLastRunId: string | undefined;
}

export function useChatEmptyKind({
  activeSessionId,
  messages,
  localMsgFilter,
  mainSurface,
  hydratedFromEngine,
  engineCursor,
  engineLastRunId,
}: UseChatEmptyKindOptions) {
  const [hydrateTimedOut, setHydrateTimedOut] = useState(false);

  useEffect(() => {
    setHydrateTimedOut(false);
  }, [activeSessionId]);

  const displayMessages = useMemo(() => {
    const q = localMsgFilter.trim();
    if (!q) return messages;
    return messages.filter((m) => messageMatchesSearch(m, q));
  }, [messages, localMsgFilter]);

  const messagesLoadingCandidate = useMemo(() => {
    if (isDemoMode()) return false;
    if (!activeSessionId) return false;
    // 草稿态（点击"新对话"后的虚拟会话）：不进入 loading 等待。
    // 草稿态本就是 0 消息的预期状态，无需等待引擎水合，直接显示 session-empty 欢迎面。
    if (isPendingDraft(activeSessionId)) return false;
    if (messages.length > 0) return false;
    if (hydratedFromEngine === true) return false;
    // hydratedFromEngine !== false（含 undefined）：旧本地会话 / 未挂引擎游标时
    // 不长期挡空态。仅当引擎明确 hydratedFromEngine===false 时才进入 loading。
    if (hydratedFromEngine !== false) {
      if (typeof engineCursor !== 'number' && !engineLastRunId) {
        return false;
      }
    }
    const isLocalMintId = /^sess-(branch-)?\d+$/i.test(activeSessionId);
    if (
      isLocalMintId &&
      typeof engineCursor !== 'number' &&
      !engineLastRunId
    ) {
      return false;
    }
    return true;
  }, [
    activeSessionId,
    messages.length,
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

  const emptyKind = resolveChatEmptyKind({
    // 草稿态（点击"新对话"后的虚拟会话）应视为"有活动会话"，
    // 走 session-empty（"我们该在 X 中处理什么？"）分支而非 no-session（"暂无会话"）。
    //
    // 旧实现：Boolean(activeSessionId) && !isPendingDraft(activeSessionId)
    //   → 草稿态 hasActiveSession=false → no-session → 显示"暂无会话"+ CTA 按钮
    //   → 用户反馈：新建对话绝不允许显示这种空屏
    //
    // 新实现：草稿态视为有活动会话，messageCount=0 时落到 session-empty 分支，
    //   显示"我们该在 X 中处理什么？"欢迎面 + 项目选择 + 快捷 prompt + composer。
    hasActiveSession: Boolean(activeSessionId),
    messageCount: messages.length,
    displayCount: displayMessages.length,
    filterQuery: localMsgFilter,
    mainSurface:
      mainSurface === 'scheduled'
        ? 'scheduled'
        : mainSurface === 'chat'
          ? 'chat'
          : undefined,
    messagesLoading,
  });
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
    displayMessages,
    messagesLoading,
    emptyKind,
    onEmptySurface,
    chatRegionAria,
  };
}
