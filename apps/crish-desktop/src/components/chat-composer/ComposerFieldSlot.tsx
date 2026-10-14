/**
 * 主对话输入域装配槽（F1-γ 契约兜底，自 ChatComposer 壳层原样提抽）：
 * - 默认主路 = TiptapComposerField（React.lazy 软接 + Suspense，加载期以
 *   textarea 同契约兜底渲染）；
 * - 富文本装配失败（lazy 加载 / 渲染抛错，InputFieldErrorBoundary 捕获）
 *   → 永久回落 ComposerField（textarea），纯文本可发送。
 * 富文本装配失败态（richTextFailed）由宿主持有并驱动 data-input-field 标记。
 */
import React from 'react';

import { ComposerField } from './ComposerField';
import type { ComposerFieldProps } from './composerTypes';
import { InputFieldErrorBoundary } from './InputFieldErrorBoundary';

/** 富文本输入（默认主路）：React.lazy 软接，装配失败回落 textarea（F1-γ） */
const TiptapComposerFieldLazy = React.lazy(() =>
  import('./TiptapComposerField').then((m) => ({
    default: m.TiptapComposerField,
  }))
);

export interface ComposerFieldSlotProps {
  /** 富文本 / textarea 共用的同一契约对象（F1-γ canonical） */
  fieldContract: ComposerFieldProps;
  /** 宿主斜杠命令（base + skill，已按输入前缀过滤） */
  filteredCommands: Array<{ cmd: string; desc: string }>;
  /** 落地面态（session-empty） */
  emptyKind?: string | undefined;
  onFilesSelected: (files: File[]) => void | Promise<void>;
  /** 剪贴板文件粘贴接管 */
  onPasteFiles?: ((files: File[]) => void | Promise<void>) | undefined;
  /** 富文本装配是否已失败（失败后固定走 textarea 分支） */
  richTextFailed: boolean;
  /** 富文本装配失败上报（宿主据此切换 data-input-field 标记） */
  onRichTextFail: () => void;
}

export const ComposerFieldSlot: React.FC<ComposerFieldSlotProps> = ({
  fieldContract,
  filteredCommands,
  emptyKind,
  onFilesSelected,
  onPasteFiles,
  richTextFailed,
  onRichTextFail,
}) => {
  if (richTextFailed) return <ComposerField {...fieldContract} />;
  return (
    <InputFieldErrorBoundary onFail={onRichTextFail}>
      <React.Suspense fallback={<ComposerField {...fieldContract} />}>
        <TiptapComposerFieldLazy
          {...fieldContract}
          baseSlashCommands={filteredCommands}
          emptyKind={emptyKind}
          onFilesSelected={onFilesSelected}
          onPasteFiles={onPasteFiles}
        />
      </React.Suspense>
    </InputFieldErrorBoundary>
  );
};
