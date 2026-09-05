import React, { useState, useRef, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { Tooltip } from '../ui';
import styles from './ModernToolCall.module.css';

export interface ModernTerminalToolCallProps {
  id?: string;
  command: string;
  output?: string;
  status?: 'running' | 'success' | 'error' | string;
  className?: string;
}

/**
 * 终端命令行工具卡片（对齐设计截图 2）
 * 包含：$ 命令头行 + 悬浮复制 + 微细分割线 + 单色等宽终端日志流 + 底部渐变淡出遮罩
 */
export const ModernTerminalToolCall: React.FC<ModernTerminalToolCallProps> = ({
  id,
  command,
  output = '',
  status = 'success',
  className = '',
}) => {
  const [copied, setCopied] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  // 检测输出内容是否超高，以决定是否渲染底部渐变淡出遮罩
  useEffect(() => {
    const el = outputRef.current;
    if (el) {
      setIsOverflowing(el.scrollHeight > el.clientHeight + 4);
    }
  }, [output]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!command) return;
    void navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={`${styles.terminalCard} ${className}`}
      data-tool-id={id}
      data-tool-status={status}
    >
      {/* 顶部命令栏：$ command */}
      <div className={styles.terminalHead}>
        <div className={styles.terminalCommandRow}>
          <span className={styles.terminalPromptDollar} aria-hidden="true">$</span>
          <Tooltip content={command}>
            <span className={styles.terminalCommandText}>
              {command}
            </span>
          </Tooltip>
        </div>

        <div className={styles.terminalActions}>
          <Tooltip content={copied ? '已复制命令' : '复制命令'}>
            <button
              type="button"
              className={styles.terminalCopyBtn}
              onClick={handleCopy}
              aria-label="复制命令行"
            >
              {copied ? (
                <Check size={12} strokeWidth={2.4} style={{ color: '#10b981' }} />
              ) : (
                <Copy size={12} strokeWidth={2} />
              )}
            </button>
          </Tooltip>
        </div>
      </div>

      <div className={styles.terminalDivider} />

      {/* 终端输出日志流 */}
      <div className={styles.terminalBody}>
        <pre ref={outputRef} className={styles.terminalOutput}>
          {output || '(no output)'}
        </pre>
        {isOverflowing ? <div className={styles.terminalFadeMask} aria-hidden="true" /> : null}
      </div>
    </div>
  );
};
