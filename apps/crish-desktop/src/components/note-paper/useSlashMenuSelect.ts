/**
 * slash 选中 / 提交钩子（SD-13）
 *
 * 点击 item 或 Enter → selectItem / selectActive →（有 sink 时）submit。
 * CONN-B：`isReadOnly` 时全部 no-op，防可点无写。
 *
 * **≠ EL-01**；**≠ A-BLK-02 e2e**。
 */

import { useCallback, useState } from 'react';
import {
  selectSlashActiveAndSubmit,
  selectSlashItemAndSubmit,
  type IntentSink,
  type SlashInsertIntent,
  type SlashMenuModel,
  type SlashSelectAndSubmitResult,
  type SubmitIntentOptions,
} from '@crish/block-paper';

export type UseSlashMenuSelectOptions = {
  menu: SlashMenuModel;
  sink?: IntentSink;
  /** CONN-B：true 时禁 select/submit */
  isReadOnly: boolean;
  submitOptions?: SubmitIntentOptions;
  onSelectIntent?: (intent: SlashInsertIntent) => void;
  onSubmitResult?: (result: SlashSelectAndSubmitResult) => void;
  onClose?: () => void;
};

export type UseSlashMenuSelectResult = {
  pending: boolean;
  runSelectItem: (catalogItemId: string) => Promise<void>;
  runSelectActive: () => Promise<void>;
  finishClose: () => void;
};

/**
 * 处理 select*AndSubmit 结果：ok / submit 阶段失败都关菜单并回调 Intent；
 * select 阶段失败（composing 等）保持菜单可能仍开。
 */
function handleSubmitResult(
  result: SlashSelectAndSubmitResult,
  onSubmitResult: ((r: SlashSelectAndSubmitResult) => void) | undefined,
  onSelectIntent: ((i: SlashInsertIntent) => void) | undefined,
  finishClose: () => void
): void {
  onSubmitResult?.(result);
  if (result.ok) {
    onSelectIntent?.(result.intent);
    finishClose();
  } else if (result.stage === 'submit') {
    // select 已关菜单；submit 拒也通知 Intent
    onSelectIntent?.(result.intent);
    finishClose();
  }
  // stage=select 失败：composing 等，菜单可能仍开
}

export function useSlashMenuSelect(
  options: UseSlashMenuSelectOptions
): UseSlashMenuSelectResult {
  const {
    menu,
    sink,
    isReadOnly,
    submitOptions,
    onSelectIntent,
    onSubmitResult,
    onClose,
  } = options;

  const [pending, setPending] = useState(false);

  const finishClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  const runSelectItem = useCallback(
    async (catalogItemId: string) => {
      if (pending) return;
      // CONN-B：只读态禁止 select/submit（防可点无写）
      if (isReadOnly) return;
      setPending(true);
      try {
        if (sink) {
          const result = await selectSlashItemAndSubmit(
            menu,
            catalogItemId,
            sink,
            submitOptions
          );
          handleSubmitResult(
            result,
            onSubmitResult,
            onSelectIntent,
            finishClose
          );
        } else {
          const sel = menu.selectItem(catalogItemId);
          if (sel.ok) {
            onSelectIntent?.(sel.intent);
            finishClose();
          }
        }
      } finally {
        setPending(false);
      }
    },
    [
      pending,
      isReadOnly,
      sink,
      menu,
      submitOptions,
      onSubmitResult,
      onSelectIntent,
      finishClose,
    ]
  );

  const runSelectActive = useCallback(async () => {
    if (pending) return;
    if (isReadOnly) return;
    setPending(true);
    try {
      if (sink) {
        const result = await selectSlashActiveAndSubmit(
          menu,
          sink,
          submitOptions
        );
        handleSubmitResult(result, onSubmitResult, onSelectIntent, finishClose);
      } else {
        const sel = menu.selectActive();
        if (sel.ok) {
          onSelectIntent?.(sel.intent);
          finishClose();
        }
      }
    } finally {
      setPending(false);
    }
  }, [
    pending,
    isReadOnly,
    sink,
    menu,
    submitOptions,
    onSubmitResult,
    onSelectIntent,
    finishClose,
  ]);

  return { pending, runSelectItem, runSelectActive, finishClose };
}
