import { useMemo, useCallback } from 'react';
import type { ChatAttachment } from '../../hooks/useChatStream';
import type { ComposerNotice } from './ComposerNoticeBar';

export interface UseComposerNoticeOptions {
  attachments: ChatAttachment[];
  noticeProp?: ComposerNotice | null;
  onDismissNotice?: () => void;
}

export interface UseComposerNoticeResult {
  effectiveNotice: ComposerNotice | null;
  handleDismissNotice: () => void;
}

/**
 * 封装输入框上方提示条派发：
 * - 聚合外部 noticeProp（如网络降级、系统错误等）；
 * - 多模态/视觉附件警告已下沉至各附件卡片左上角橙色感叹号气泡展示，避免上方提示条常驻挤占空间。
 */
export function useComposerNotice({
  attachments: _attachments,
  noticeProp,
  onDismissNotice,
}: UseComposerNoticeOptions): UseComposerNoticeResult {
  const effectiveNotice = useMemo<ComposerNotice | null>(() => {
    if (noticeProp) return noticeProp;
    return null;
  }, [noticeProp]);

  const handleDismissNotice = useCallback(() => {
    onDismissNotice?.();
  }, [onDismissNotice]);

  return {
    effectiveNotice,
    handleDismissNotice,
  };
}
