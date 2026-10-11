/**
 * apps/crish-desktop/src/components/chat-card/useChatInput.ts
 * 基于 sessionDraftManager 的会话隔离输入协调器（详案 03 §2.2）。
 * - 会话切换微任务原子 Barrier：Flush 旧会话 → Reset DOM → Hydrate 新会话；
 * - 移除 350ms 本地防抖与 composerSeed sessionStorage 通道，持久化由
 *   sessionDraftManager（300ms 防抖 + flushSession/flushAll 原子强刷）统一承接；
 * - beforeunload / visibilitychange 守卫：离开前强刷当前会话草稿；
 * - 订阅 sessionDraftManager：后台会话定向注入零视口干扰，命中活跃会话则水合。
 *
 * 接口兼容：chatInput / setChatInput / isComposing / setIsComposing 照旧；
 * 新增 hasUndo / handleUndoDraft / draftInjectionTick（供撤销浮条与占位符聚焦）。
 *
 * CI Guardrail: Max 400 lines of effective code, UTF-8 无 BOM.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';

export interface UseChatInputOptions {
  activeSessionId: string | null;
}

export interface UseChatInputResult {
  chatInput: string;
  setChatInput: (textOrFn: React.SetStateAction<string>) => void;
  isComposing: boolean;
  setIsComposing: React.Dispatch<React.SetStateAction<boolean>>;
  /** 当前会话是否存在可撤销的外部模板覆盖历史 */
  hasUndo: boolean;
  /** 撤销最近一次外部模板覆盖（100% 原位恢复） */
  handleUndoDraft: () => void;
  /** 注入信号自增（命中活跃会话的 injectSeed/undoDraft 事件），驱动占位符聚焦 */
  draftInjectionTick: number;
}

export function useChatInput({
  activeSessionId,
}: UseChatInputOptions): UseChatInputResult {
  const [chatInput, setChatInputState] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [hasUndo, setHasUndo] = useState(false);
  const [draftInjectionTick, setDraftInjectionTick] = useState(0);

  const activeSessionIdRef = useRef(activeSessionId);
  const latestTextRef = useRef('');

  // 1. 会话切换原子 Barrier（Flush 旧会话草稿 → 复位 DOM → Hydrate 新会话）
  // 用布局 effect 在新会话首次可交互前完成切换，避免输入事件命中旧会话 ref。
  useLayoutEffect(() => {
    const prevSid = activeSessionIdRef.current;
    if (prevSid && prevSid !== activeSessionId) {
      // Barrier 阶段 1：强刷旧会话草稿至 Level 2/3（同步，作废其挂起防抖）
      sessionDraftManager.setDraft(prevSid, latestTextRef.current, true);
    }
    activeSessionIdRef.current = activeSessionId;

    if (!activeSessionId) {
      setChatInputState('');
      latestTextRef.current = '';
      setHasUndo(false);
      return;
    }

    // Barrier 阶段 2：从 SessionDraftManager 精确恢复新会话草稿
    const restored = sessionDraftManager.getDraft(activeSessionId);
    setChatInputState(restored);
    latestTextRef.current = restored;
    setHasUndo(sessionDraftManager.hasUndo(activeSessionId));
  }, [activeSessionId]);

  // 2. 页面卸载 / 隐藏守卫（Unload / Hidden Barrier，尽力而为的即时持久化）
  useEffect(() => {
    const onFlush = () => {
      const sid = activeSessionIdRef.current;
      if (sid) {
        sessionDraftManager.setDraft(sid, latestTextRef.current, true);
      }
    };
    window.addEventListener('beforeunload', onFlush);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onFlush();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('beforeunload', onFlush);
      document.removeEventListener('visibilitychange', onVisibility);
      onFlush();
    };
  }, []);

  // 3. 用户输入调度：本地状态 + sessionDraftManager（300ms 防抖落 Store）
  const setChatInput = useCallback((textOrFn: React.SetStateAction<string>) => {
    const sid = activeSessionIdRef.current;
    setChatInputState((prev) => {
      const next =
        typeof textOrFn === 'function' ? textOrFn(prev) : textOrFn;
      latestTextRef.current = next;
      if (sid) {
        sessionDraftManager.setDraft(sid, next, false);
      }
      return next;
    });
  }, []);

  // 4. 订阅定向注入 / 撤销事件（后台会话注入零视口干扰）
  useEffect(() => {
    return sessionDraftManager.subscribe(({ sessionId, content, hasUndo: undoAvail }) => {
      if (sessionId === activeSessionIdRef.current) {
        setChatInputState(content);
        latestTextRef.current = content;
        setHasUndo(undoAvail);
        setDraftInjectionTick((t) => t + 1);
      }
    });
  }, []);

  // 5. 撤销操作（外部模板覆盖原位无损恢复）
  const handleUndoDraft = useCallback(() => {
    const sid = activeSessionIdRef.current;
    if (sid) {
      sessionDraftManager.undoDraft(sid);
    }
  }, []);

  return {
    chatInput,
    setChatInput,
    isComposing,
    setIsComposing,
    hasUndo,
    handleUndoDraft,
    draftInjectionTick,
  };
}
