/**
 * Strict content-row 叶宿主（CONN-D3 · HiddenInput 方向产品路径）
 *
 * ## 角色
 * - 把原先静态 `content-row` 正文接到 `commitProductMdPrefixFromLeaf`
 * - 可写：contenteditable 叶缓冲；行首 `# `/`- ` 等完整前缀后尝试 turn_into
 * - disabled：只读静态文，**不**假转块
 *
 * ## 诚实边界
 * - **≠** A-BLK-08/09 全 e2e / **≠ EL-01** / **≠** 真 PM View 键入全链
 * - 成功仅证明桌面叶→桥写锥形状；kind 权威仍在投影 / RS apply
 * - UI **禁止**用 pending_turn_into_flavour 改 `data-flavour`（本组件不碰 kind）
 * - composing 双守卫：composition 期不 commit
 * - **只**走 TurnIntoSink；**不**触 slash IntentSink（通道不互抹）
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TurnIntoIntent } from '@crish/block-paper';
import {
  bindingFromStrictMdPrefixProps,
  commitProductMdPrefixFromLeaf,
  type ProductMdPrefixBinding,
  type ProductMdPrefixCommitResult,
  type ProductMdPrefixSinkSource,
  type ProductMdPrefixWriteMode,
} from './noteMdPrefixBridge';
import styles from './NotePaperPanel.module.css';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type StrictContentRowLeafProps = {
  blockId: string;
  /** 投影 flavour（权威 kind 来源；本叶不得因 pending 改写） */
  flavour: string;
  /** hydrate 投影正文 */
  text: string;
  mdPrefixWriteMode?: ProductMdPrefixWriteMode;
  turnIntoSink?: ProductMdPrefixBinding['sink'];
  mdPrefixSinkSource?: ProductMdPrefixSinkSource;
  /** 完整 binding（优先；有 collab 时测可断言 wireCalls） */
  mdPrefixBinding?: ProductMdPrefixBinding;
  /** 提交结果回调（测 / 宿主；不得旁路写盘） */
  onMdPrefixCommit?: (result: ProductMdPrefixCommitResult) => void;
  onCommittedIntent?: (intent: TurnIntoIntent) => void;
  className?: string;
};

// ---------------------------------------------------------------------------
// 产品路径：叶缓冲变更后尝试 MD 前缀
// ---------------------------------------------------------------------------

/**
 * content-row 叶缓冲提交入口（纯逻辑，可单测）。
 * composing=true 或 disabled → 拒绝；完整行首前缀 → commitProductMdPrefixFromLeaf。
 */
export async function tryCommitStrictLeafMdPrefix(input: {
  blockId: string;
  text: string;
  fromFlavour: string;
  isComposing: boolean;
  binding: ProductMdPrefixBinding;
  createIntentId?: () => string;
  onCommitted?: (intent: TurnIntoIntent) => void;
}): Promise<ProductMdPrefixCommitResult> {
  if (input.isComposing) {
    return {
      ok: false,
      stage: 'fast_path',
      code: 'composing',
      reason:
        'tryCommitStrictLeafMdPrefix：composing 中（CONN-D3 双守卫；不进 sink）',
    };
  }
  return commitProductMdPrefixFromLeaf(
    {
      blockId: input.blockId,
      text: input.text,
      caretOffset: input.text.length,
      isComposing: false,
      fromFlavour: input.fromFlavour,
    },
    input.binding,
    {
      ...(input.createIntentId !== undefined
        ? { createIntentId: input.createIntentId }
        : {}),
      ...(input.onCommitted !== undefined
        ? { onCommitted: input.onCommitted }
        : {}),
    }
  );
}

// ---------------------------------------------------------------------------
// React 叶宿主
// ---------------------------------------------------------------------------

/**
 * Strict content-row 正文叶：可写时 HiddenInput 方向 contenteditable；
 * disabled 时静态 text。**不**根据 pending 改 flavour。
 */
export const StrictContentRowLeaf: React.FC<StrictContentRowLeafProps> = ({
  blockId,
  flavour,
  text: projectionText,
  mdPrefixWriteMode,
  turnIntoSink,
  mdPrefixSinkSource,
  mdPrefixBinding: bindingProp,
  onMdPrefixCommit,
  onCommittedIntent,
  className,
}) => {
  const binding = useMemo(
    () =>
      bindingProp ??
      bindingFromStrictMdPrefixProps({
        turnIntoSink,
        writeMode: mdPrefixWriteMode,
        sinkSource: mdPrefixSinkSource,
      }),
    [bindingProp, turnIntoSink, mdPrefixWriteMode, mdPrefixSinkSource]
  );

  const writable = binding.mode === 'writable' && Boolean(binding.sink);
  const composingRef = useRef(false);
  const elRef = useRef<HTMLDivElement | null>(null);
  /** 防 input 重入 / 未完成 commit 交错 */
  const commitInFlight = useRef(false);
  /** 是否已由用户本地编辑（投影刷新时避免抢回） */
  const dirtyRef = useRef(false);

  // contenteditable 非受控：挂载 / 投影刷新时写 textContent（勿用 React children 控光标）
  useEffect(() => {
    if (!writable) return;
    const el = elRef.current;
    if (!el) return;
    if (composingRef.current || commitInFlight.current || dirtyRef.current) {
      return;
    }
    const next = projectionText ?? '';
    if (el.textContent !== next) {
      el.textContent = next;
    }
  }, [projectionText, writable]);

  const runCommit = useCallback(
    async (plain: string) => {
      if (!writable || commitInFlight.current) return;
      if (composingRef.current) return;
      // 无完整空格结尾的前缀时库会拒；仍走桥以统一路径
      commitInFlight.current = true;
      try {
        const result = await tryCommitStrictLeafMdPrefix({
          blockId,
          text: plain,
          fromFlavour: flavour,
          isComposing: composingRef.current,
          binding,
          onCommitted: onCommittedIntent,
        });
        onMdPrefixCommit?.(result);
        if (result.ok) {
          // 剥离前缀后的叶缓冲；**不**改 data-flavour（kind 权威 = 投影）
          const stripped = result.strippedText;
          const el = elRef.current;
          if (el && el.textContent !== stripped) {
            el.textContent = stripped;
          }
          dirtyRef.current = true;
        }
      } finally {
        commitInFlight.current = false;
      }
    },
    [writable, blockId, flavour, binding, onCommittedIntent, onMdPrefixCommit]
  );

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (ev: React.CompositionEvent<HTMLDivElement>) => {
      composingRef.current = false;
      dirtyRef.current = true;
      const plain = ev.currentTarget.textContent ?? '';
      void runCommit(plain);
    },
    [runCommit]
  );

  const onInput = useCallback(
    (ev: React.FormEvent<HTMLDivElement>) => {
      dirtyRef.current = true;
      const plain = ev.currentTarget.textContent ?? '';
      if (composingRef.current) return;
      void runCommit(plain);
    },
    [runCommit]
  );

  const rootClass = [styles.text, className].filter(Boolean).join(' ');

  if (!writable) {
    // disabled：静态正文，无 HiddenInput 提交路径（不假转块）
    return (
      <div
        className={rootClass}
        data-testid={`note-strict-leaf-${blockId}`}
        data-strict-leaf-input="0"
        data-md-prefix-leaf-mode="disabled"
        data-block-id={blockId}
        data-from-flavour={flavour}
      >
        {projectionText ?? ''}
      </div>
    );
  }

  return (
    <div
      ref={elRef}
      className={rootClass}
      role="textbox"
      tabIndex={0}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-testid={`note-strict-leaf-${blockId}`}
      data-strict-leaf-input="1"
      data-md-prefix-leaf-mode="writable"
      data-block-id={blockId}
      data-from-flavour={flavour}
      aria-label="块正文叶"
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onInput={onInput}
    />
  );
};

export default StrictContentRowLeaf;
