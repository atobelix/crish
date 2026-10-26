import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatAttachment } from '../../hooks/useChatStream';
import {
  resolveNoticeSeverity,
  type ComposerNotice,
} from './composerNoticeTypes';

export interface UseComposerNoticeOptions {
  attachments: ChatAttachment[];
  noticeProp?: ComposerNotice | null;
  onDismissNotice?: () => void;
}

export interface UseComposerNoticeResult {
  effectiveNotice: ComposerNotice | null;
  isClosing: boolean;
  handleDismissNotice: () => void;
}

const EXIT_DURATION_MS = 120;

/**
 * 比较两个 Notice 是否具有相同的实体内容（避免父组件非 memoized 对象引起误刷新）
 */
function isNoticeEqual(
  a: ComposerNotice | null | undefined,
  b: ComposerNotice | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    resolveNoticeSeverity(a) === resolveNoticeSeverity(b) &&
    a.type === b.type &&
    a.message === b.message &&
    a.detail === b.detail
  );
}

/**
 * 封装输入坞内嵌通知顶槽两阶段平滑退场状态机：
 * - 聚合外部 noticeProp（如网络降级、系统错误、上下文超限等）；
 * - 点击关闭触发两阶段退场：置位 isClosing=true 并启动 120ms 定时器；
 * - 定时器到期后重置 displayNotice=null 与 isClosing=false；
 * - 退场期间若外部传入新 noticeProp，立即取消定时器并展示新通知，重置 isClosing=false。
 */
export function useComposerNotice({
  attachments: _attachments,
  noticeProp,
  onDismissNotice,
}: UseComposerNoticeOptions): UseComposerNoticeResult {
  const [displayNotice, setDisplayNotice] = useState<ComposerNotice | null>(
    () => noticeProp ?? null
  );
  const [isClosing, setIsClosing] = useState<boolean>(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevNoticePropRef = useRef<ComposerNotice | null | undefined>(
    noticeProp
  );
  const onDismissNoticeRef = useRef(onDismissNotice);
  onDismissNoticeRef.current = onDismissNotice;

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, []);

  // 监听 noticeProp 外部变更
  useEffect(() => {
    if (!isNoticeEqual(prevNoticePropRef.current, noticeProp)) {
      const wasClosing = isClosing;
      prevNoticePropRef.current = noticeProp;

      if (noticeProp) {
        // 退场期间或正常展示期间，若传入新 notice，立即取消定时器并展示
        if (exitTimerRef.current) {
          clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
        }
        setDisplayNotice(noticeProp);
        setIsClosing(false);
      } else {
        // 外部置空 noticeProp：若不是在 handleDismissNotice 退场动画中，立即清空
        if (!wasClosing) {
          if (exitTimerRef.current) {
            clearTimeout(exitTimerRef.current);
            exitTimerRef.current = null;
          }
          setDisplayNotice(null);
        }
      }
    }
  }, [noticeProp, isClosing]);

  const handleDismissNotice = useCallback(() => {
    onDismissNoticeRef.current?.();
    setIsClosing(true);
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
    }
    exitTimerRef.current = setTimeout(() => {
      setDisplayNotice(null);
      setIsClosing(false);
      exitTimerRef.current = null;
    }, EXIT_DURATION_MS);
  }, []);

  return {
    effectiveNotice: displayNotice,
    isClosing,
    handleDismissNotice,
  };
}
