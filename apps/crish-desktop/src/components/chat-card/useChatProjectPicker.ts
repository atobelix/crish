import { useState, useEffect, useRef } from 'react';
import { useLayoutStore } from '../../store/storeAccess';
import { onUiEvent } from '../../api/uiEvents';
import { onScopedUiEvent } from '../../hooks/useLeafUiEvent';
import { useLeafScope } from '../../contexts/LeafScopeContext';

type ChatMainSurface = 'chat' | 'scheduled';

export interface UseChatProjectPickerOptions {
  /** 活跃会话 ID，用于会话切换重置过滤 */
  activeSessionId: string | null;
}

export interface UseChatProjectPickerResult {
  showProjectPicker: boolean;
  setShowProjectPicker: React.Dispatch<React.SetStateAction<boolean>>;
  mainSurface: ChatMainSurface;
  setMainSurface: (surface: ChatMainSurface) => void;
  projectTick: number;
  setProjectTick: React.Dispatch<React.SetStateAction<number>>;
  localMsgFilter: string;
  setLocalMsgFilter: React.Dispatch<React.SetStateAction<string>>;
  showMsgFilter: boolean;
  setShowMsgFilter: React.Dispatch<React.SetStateAction<boolean>>;
  msgFilterInputRef: React.RefObject<HTMLInputElement | null>;
  isFiltering: boolean;
}

export function useChatProjectPicker({
  activeSessionId,
}: UseChatProjectPickerOptions): UseChatProjectPickerResult {
  const scope = useLeafScope();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const mainSurface: ChatMainSurface =
    useLayoutStore((s) => s.chatMainSurface) ?? 'chat';
  const setMainSurface = useLayoutStore((s) => s.setChatMainSurface);
  const [projectTick, setProjectTick] = useState(0);
  const [localMsgFilter, setLocalMsgFilter] = useState('');
  const [showMsgFilter, setShowMsgFilter] = useState(false);
  const msgFilterInputRef = useRef<HTMLInputElement>(null);

  // UI 事件监听（定址化隔离：快捷键/菜单仅作用于所属/激活分屏）
  useEffect(() => {
    const getTarget = () => ({
      sessionId: activeSessionIdRef.current,
      leafId: scopeRef.current.leafId,
      isActive: scopeRef.current.inLeafScope
        ? scopeRef.current.isActive
        : undefined,
    });

    const offs = [
      onUiEvent('project-changed', () => setProjectTick((n) => n + 1)),
      onScopedUiEvent(
        'open-project-picker',
        () => setShowProjectPicker(true),
        getTarget
      ),
      onScopedUiEvent(
        'open-scheduled',
        () => setMainSurface('scheduled'),
        getTarget
      ),
      onScopedUiEvent('open-chat', () => setMainSurface('chat'), getTarget),
      onScopedUiEvent(
        'toggle-msg-filter',
        () => {
          setShowMsgFilter((v) => {
            const next = !v;
            if (!next) setLocalMsgFilter('');
            return next;
          });
        },
        getTarget
      ),
      onScopedUiEvent(
        'focus-composer',
        () => {
          setMainSurface('chat');
          window.requestAnimationFrame(() => {
            const curScope = scopeRef.current;
            const root = curScope.leafRootRef.current;
            const selector =
              '.tiptap[contenteditable="true"], [data-chat-composer] [contenteditable="true"], textarea[data-chat-composer], textarea.chat-input, .chat-composer textarea, .composer-textarea, .chat-footer textarea, [contenteditable="true"]';
            const el =
              (root ? root.querySelector<HTMLElement>(selector) : null) ||
              curScope.queryWithinLeaf<HTMLElement>(selector) ||
              (typeof document !== 'undefined'
                ? document.querySelector<HTMLElement>(selector)
                : null);
            el?.focus();
          });
        },
        getTarget
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [setMainSurface]);

  // 会话切换重置过滤
  useEffect(() => {
    setLocalMsgFilter('');
    setShowMsgFilter(false);
  }, [activeSessionId]);

  // 过滤框聚焦
  useEffect(() => {
    if (showMsgFilter) {
      window.requestAnimationFrame(() => msgFilterInputRef.current?.focus());
    }
  }, [showMsgFilter]);

  const isFiltering = Boolean(localMsgFilter.trim());

  return {
    showProjectPicker,
    setShowProjectPicker,
    mainSurface,
    setMainSurface,
    projectTick,
    setProjectTick,
    localMsgFilter,
    setLocalMsgFilter,
    showMsgFilter,
    setShowMsgFilter,
    msgFilterInputRef,
    isFiltering,
  };
}
