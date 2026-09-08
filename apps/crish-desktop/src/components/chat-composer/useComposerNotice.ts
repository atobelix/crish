import { useState, useEffect, useMemo, useCallback } from 'react';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { useModelVisionWarning } from '../../api/modelVisionSupport';
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
 * 封装输入框上方提示条派发与模型视觉警告生命周期：
 * - 监听模型切换/附件变化并派发视觉告警
 * - 支持用户手动关闭本条告警并在变更后解除屏蔽
 * - 统一聚合 noticeProp 与视觉告警
 */
export function useComposerNotice({
  attachments,
  noticeProp,
  onDismissNotice,
}: UseComposerNoticeOptions): UseComposerNoticeResult {
  const visionWarning = useModelVisionWarning(attachments);
  const [dismissedNoticeKey, setDismissedNoticeKey] = useState<string | null>(null);

  useEffect(() => {
    if (visionWarning && dismissedNoticeKey && dismissedNoticeKey !== visionWarning) {
      setDismissedNoticeKey(null);
    }
  }, [visionWarning, dismissedNoticeKey]);

  const effectiveNotice = useMemo<ComposerNotice | null>(() => {
    if (noticeProp) return noticeProp;
    if (visionWarning && dismissedNoticeKey !== visionWarning) {
      return {
        id: `vision-${visionWarning}`,
        type: 'warning',
        message: visionWarning,
        detail:
          '当前选中的模型不支持输入图像或复杂文档直接解析。建议切换至具备视觉/多模态能力的大模型，或将文档转为纯文本后再行发送。',
      };
    }
    return null;
  }, [noticeProp, visionWarning, dismissedNoticeKey]);

  const handleDismissNotice = useCallback(() => {
    if (effectiveNotice?.message) {
      setDismissedNoticeKey(effectiveNotice.message);
    }
    onDismissNotice?.();
  }, [effectiveNotice, onDismissNotice]);

  return {
    effectiveNotice,
    handleDismissNotice,
  };
}
