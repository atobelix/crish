/**
 * 主对话输入域「附件与文件交互」聚簇 hook：
 * - 输入域聚焦回迁（tiptap contenteditable 根 / textarea 兜底共用）；
 * - 隐藏 file input 受控属性（模型视觉能力联动，接入 onFilesSelected）；
 * - 附件移除（含待提交批注的原位撤销）；
 * - 卡片内点击附件 / 文件 mention → 交由宿主打开对应叶。
 * 自 ChatComposer 壳层内联逻辑原样提抽，行为不变。
 */
import type React from 'react';
import { useCallback } from 'react';

import type { ChatAttachment } from '../../hooks/useChatStream';
import { useComposerHiddenFileInputProps } from '../../api/modelVisionSupport';
import { removePendingFileAnnotation } from '../../api/workspaceFsApi';

export interface UseComposerFileHandlersOptions {
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  /** 当前叶子作用域会话 id（批注撤销键） */
  scopedSessionId: string;
  /** 输入域外壳 ref（富文本 contenteditable / textarea 共用） */
  fieldContainerRef: React.RefObject<HTMLDivElement | null>;
  onFilesSelected: (files: File[]) => void | Promise<void>;
  /** 点附件 / 文件 mention → files / file-viewer 叶；不传则不接线 */
  onOpenPath?: ((filePath: string) => void) | undefined;
}

export interface UseComposerFileHandlersResult {
  /** 聚焦输入域（tiptap contenteditable 或 textarea 兜底） */
  focusComposerTextarea: () => void;
  /** 隐藏 file input 受控属性（含模型视觉能力联动） */
  hiddenFileInputProps: ReturnType<typeof useComposerHiddenFileInputProps>;
  /** 移除附件（含待提交批注撤销） */
  handleRemoveAttachment: (identifier: string) => void;
  /** 卡片内点击附件 / 文件路径 → 打开对应叶 */
  handleFileOpenClick: (e: React.MouseEvent) => void;
}

export function useComposerFileHandlers({
  setAttachments,
  scopedSessionId,
  fieldContainerRef,
  onFilesSelected,
  onOpenPath,
}: UseComposerFileHandlersOptions): UseComposerFileHandlersResult {
  const focusComposerTextarea = useCallback(() => {
    const root = fieldContainerRef.current;
    // tiptap 编辑器为 contenteditable 根；textarea 分支兼容侧栏 ComposerField 复用
    const el =
      root?.querySelector?.('textarea.composer-textarea') ??
      root?.querySelector?.('textarea') ??
      root?.querySelector?.('[contenteditable="true"]');
    if (el instanceof HTMLElement) el.focus();
  }, [fieldContainerRef]);

  const hiddenFileInputProps = useComposerHiddenFileInputProps(
    async (files) => {
      await onFilesSelected(files);
      requestAnimationFrame(focusComposerTextarea);
    }
  );

  const handleRemoveAttachment = useCallback(
    (identifier: string) => {
      setAttachments((prev) => {
        const targetIndex = prev.findIndex(
          (x) => (x.id && x.id === identifier) || x.name === identifier
        );
        if (targetIndex === -1) return prev;
        const target = prev[targetIndex];
        if (target?.annotation?.id) {
          removePendingFileAnnotation(target.annotation.id, scopedSessionId);
        }
        return prev.filter((_, idx) => idx !== targetIndex);
      });
    },
    [setAttachments, scopedSessionId]
  );

  const handleFileOpenClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onOpenPath) return;
      const t =
        e.target instanceof Element
          ? e.target
          : e.target instanceof Node
            ? e.target.parentElement
            : null;
      if (!t) return;
      if (t.closest('.chat-attach-remove')) return;
      const el = t.closest('[data-file-open-path]');
      if (!(el instanceof HTMLElement)) return;
      const path = (el.getAttribute('data-file-open-path') || '').trim();
      if (!path || /^(note|notebook)(:|$)/i.test(path)) return;
      if (!/[\\/]/.test(path) && !/\.[A-Za-z0-9]{1,12}$/.test(path)) return;
      e.preventDefault();
      e.stopPropagation();
      onOpenPath(path);
    },
    [onOpenPath]
  );

  return {
    focusComposerTextarea,
    hiddenFileInputProps,
    handleRemoveAttachment,
    handleFileOpenClick,
  };
}
