/**
 * InlineAgentPanel 输入区（F1-β 拆分，纯展示）：
 * dense ComposerField（footer 渐变 + ≤3 行增高 + 主题半透壳）装配；
 * onSend 闭包由壳组件收敛（trim + 清空 + handleSend），此处仅接线。
 * 零 hook / 零 store。
 */
import React from 'react';
import styles from './InlineAgentPanel.module.css';
import { ComposerField } from '../chat-composer/ChatComposer';

export interface InlineAgentComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  /** L2 cooperative_stop（单击） */
  onStop: () => void;
  /** L3 force_cancel（Shift+点击 / 长按） */
  onForceStop: () => void;
  canSend: boolean;
  disabled: boolean;
  isComposing: boolean;
  setIsComposing: (v: boolean) => void;
  isProcessing: boolean;
  maxLines: number;
  placeholder: string;
  ariaLabel: string;
}

export const InlineAgentComposer: React.FC<InlineAgentComposerProps> = ({
  value,
  onChange,
  onSend,
  onStop,
  onForceStop,
  canSend,
  disabled,
  isComposing,
  setIsComposing,
  isProcessing,
  maxLines,
  placeholder,
  ariaLabel,
}) => {
  return (
    /* denser ComposerField：footer 渐变 + ≤3 行增高 + 主题半透壳 */
    <div
      className={`chat-footer agent-card-composer agent-card-composer--dense ${styles.inlineAgentComposerWrap} ${styles.inlineAgentComposerWrapDense}`}
      data-composer="inline-agent-dense"
    >
      <ComposerField
        value={value}
        onChange={onChange}
        onSend={onSend}
        canSend={canSend}
        disabled={disabled}
        isComposing={isComposing}
        setIsComposing={setIsComposing}
        isProcessing={isProcessing}
        onStop={onStop}
        onForceStop={onForceStop}
        processingSendLabel="发送"
        maxLines={maxLines}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        dense
        className={styles.noOutlineComposer}
      />
    </div>
  );
};
