// G5b · 已选附件 VM：三入口选取 + 逐个移除 + 成功清空
//
// 状态纪律（简报条目 2）：
// - 选取失败（权限被拒 / 压缩后仍超限）经 notify 诚实提示且不入队；
//   用户取消静默返回；
// - 发送失败保留已选区（宿主 VM 返回 false 时不清空），发送成功由
//   宿主调用 clear() 清空——清空动作只发生在成功路径；
// - 选取在途（picking）时重复触发直接忽略，避免双开选择器。
import { useCallback, useRef, useState } from 'react';

import type { ComposerAttachment } from '../../domain/pure/attachments';
import {
  expoAttachmentIntake,
  type AttachmentIntake,
  type AttachmentPickOutcome,
} from '../attachments/attachmentIntake';

export interface UseComposerAttachmentsOptions {
  /** 提示面（宿主接 toast）：权限被拒 / 超限拒绝等诚实提示走这里 */
  notify: (message: string) => void;
  /** 测试注入：缺省走 expo 真实实现 */
  intakeOverride?: AttachmentIntake;
}

export interface ComposerAttachmentsApi {
  attachments: readonly ComposerAttachment[];
  /** 正在打开选择器 / 处理所选文件 */
  picking: boolean;
  pickFromCamera: () => void;
  pickFromLibrary: () => void;
  pickFromFiles: () => void;
  remove: (id: string) => void;
  /** 发送受理后清空（失败路径不得调用） */
  clear: () => void;
  /** 失败恢复（R5）：受理快照整体还原已选区（替换语义，不追加去重） */
  restore: (items: readonly ComposerAttachment[]) => void;
}

export function useComposerAttachments(
  options: UseComposerAttachmentsOptions
): ComposerAttachmentsApi {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pickingRef = useRef(false);

  const runPick = useCallback(
    (pick: (intake: AttachmentIntake) => Promise<AttachmentPickOutcome>) => {
      if (pickingRef.current) return;
      pickingRef.current = true;
      setPicking(true);
      const intake = optionsRef.current.intakeOverride ?? expoAttachmentIntake;
      void (async () => {
        try {
          const outcome = await pick(intake);
          if (outcome.kind === 'picked') {
            setAttachments((prev) => [...prev, outcome.attachment]);
          } else if (outcome.kind === 'denied' || outcome.kind === 'failed') {
            optionsRef.current.notify(outcome.message);
          } else if (outcome.kind === 'tooLarge') {
            optionsRef.current.notify(outcome.message);
          }
          // cancelled：静默
        } catch {
          optionsRef.current.notify('附件选取失败，请重试');
        } finally {
          pickingRef.current = false;
          setPicking(false);
        }
      })();
    },
    []
  );

  const pickFromCamera = useCallback(
    () => runPick((intake) => intake.pickFromCamera()),
    [runPick]
  );
  const pickFromLibrary = useCallback(
    () => runPick((intake) => intake.pickFromLibrary()),
    [runPick]
  );
  const pickFromFiles = useCallback(
    () => runPick((intake) => intake.pickFromFiles()),
    [runPick]
  );

  const remove = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
  }, []);

  const restore = useCallback((items: readonly ComposerAttachment[]) => {
    setAttachments([...items]);
  }, []);

  return {
    attachments,
    picking,
    pickFromCamera,
    pickFromLibrary,
    pickFromFiles,
    remove,
    clear,
    restore,
  };
}
