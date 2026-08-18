import { useState, useEffect, useRef } from 'react';
import { useLayoutStore } from '../../store/storeAccess';
import { onUiEvent } from '../../api/uiEvents';

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
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const mainSurface: ChatMainSurface =
    useLayoutStore((s) => s.chatMainSurface) ?? 'chat';
  const setMainSurface = useLayoutStore((s) => s.setChatMainSurface);
  const [projectTick, setProjectTick] = useState(0);
  const [localMsgFilter, setLocalMsgFilter] = useState('');
  const [showMsgFilter, setShowMsgFilter] = useState(false);
  const msgFilterInputRef = useRef<HTMLInputElement>(null);

  // UI 事件监听（project-changed/open-project-picker/open-scheduled/
  // open-chat/toggle-msg-filter/focus-composer）
  useEffect(() => {
    const offs = [
      onUiEvent('project-changed', () => setProjectTick((n) => n + 1)),
      onUiEvent('open-project-picker', () => setShowProjectPicker(true)),
      onUiEvent('open-scheduled', () => setMainSurface('scheduled')),
      onUiEvent('open-chat', () => setMainSurface('chat')),
      onUiEvent('toggle-msg-filter', () => {
        setShowMsgFilter((v) => {
          const next = !v;
          if (!next) setLocalMsgFilter('');
          return next;
        });
      }),
      onUiEvent('focus-composer', () => {
        setMainSurface('chat');
        window.requestAnimationFrame(() => {
          const el =
            document.querySelector<HTMLTextAreaElement>(
              'textarea[data-chat-composer], .chat-composer textarea, .composer-textarea'
            ) ||
            document.querySelector<HTMLTextAreaElement>(
              '.chat-footer textarea'
            );
          el?.focus();
        });
      }),
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
