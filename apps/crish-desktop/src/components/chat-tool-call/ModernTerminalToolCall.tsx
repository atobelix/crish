import React, { useState, useMemo } from 'react';
import { Button, Tooltip } from '@/components/ui';
import { parseAnsi } from '../../utils/parseAnsi';
import styles from './ModernToolCall.module.css';
import { AppIcon } from '@/components/ui/icons';
import { useTransientFlag } from '../../hooks/useTransientFlag';

export interface ModernTerminalToolCallProps {
  id?: string;
  command: string;
  output?: string;
  status?: 'running' | 'success' | 'error' | string;
  className?: string;
}

export const TERMINAL_FOLD_THRESHOLD = 30;
export const TERMINAL_HEAD_LINES = 15;
export const TERMINAL_TAIL_LINES = 15;

/**
 * 终端命令行工具卡片（自适应高度与单一滚动宿主合规）
 * 包含：$ 命令头行 + 悬浮复制 + 微细分割线 + ANSI 原生轻量高亮日志流 + 渐进截断折叠
 * 绝不包含内部嵌套第二重纵向滚动条，高度完全自适应融入主文档流
 */
export const ModernTerminalToolCall: React.FC<ModernTerminalToolCallProps> = ({
  id,
  command,
  output = '',
  status = 'success',
  className = '',
}) => {
  // 复制反馈瞬态位：定时器由 useTransientFlag 统一持有并在卸载时清除
  // （历史手写 setTimeout 不清理 ⇒ 组件被虚拟列表回收后仍 setState，
  //  在环境已拆除时访问 window 抛未捕获异常）。
  const { flag: copied, trigger: triggerCopied } = useTransientFlag(1500);
  const { flag: copiedOutput, trigger: triggerCopiedOutput } =
    useTransientFlag(1500);
  const [isFullExpanded, setIsFullExpanded] = useState(false);

  // ANSI 解析与渐进截断折叠切片
  const normalizedOutput = useMemo(() => {
    if (!output) return '';
    return output.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }, [output]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!command) return;
    void navigator.clipboard.writeText(command);
    triggerCopied();
  };

  const handleCopyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!normalizedOutput) return;
    void navigator.clipboard.writeText(normalizedOutput);
    triggerCopiedOutput();
  };

  const lines = useMemo(() => {
    if (!normalizedOutput) return [];
    return normalizedOutput.split('\n');
  }, [normalizedOutput]);

  const shouldFold = lines.length > TERMINAL_FOLD_THRESHOLD && !isFullExpanded;

  return (
    <div
      className={`${styles.terminalCard} ${className}`}
      data-tool-id={id}
      data-tool-status={status}
    >
      {/* 顶部命令栏：$ command */}
      <div className={styles.terminalHead}>
        <div className={styles.terminalCommandRow}>
          <span className={styles.terminalPromptDollar} aria-hidden="true">
            $
          </span>
          <Tooltip content={command || '$'}>
            <span className={styles.terminalCommandText}>{command}</span>
          </Tooltip>
        </div>

        <div className={styles.terminalActions}>
          <Tooltip content={copied ? '已复制命令' : '复制命令'}>
            <Button
              type="button"
              variant="ghost"
              className={styles.terminalCopyBtn}
              onClick={handleCopy}
              aria-label="复制命令行"
            >
              {copied ? (
                <AppIcon
                  name="check"
                  size={12}
                  className={styles.copiedCheckIcon}
                />
              ) : (
                <AppIcon name="copy" size={12} />
              )}
            </Button>
          </Tooltip>
          {Boolean(normalizedOutput) && (
            <Tooltip content={copiedOutput ? '已复制输出' : '复制终端输出'}>
              <Button
                type="button"
                variant="ghost"
                className={styles.terminalCopyBtn}
                onClick={handleCopyOutput}
                aria-label="复制终端输出"
              >
                {copiedOutput ? (
                  <AppIcon
                    name="check"
                    size={12}
                    className={styles.copiedCheckIcon}
                  />
                ) : (
                  <AppIcon name="file-text" size={12} />
                )}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className={styles.terminalDivider} />

      {/* 终端输出日志流：自适应高度，无局部滚动条 */}
      <div className={styles.terminalBody}>
        <pre className={styles.terminalOutput}>
          {!output ? (
            '(no output)'
          ) : shouldFold ? (
            <>
              {lines.slice(0, TERMINAL_HEAD_LINES).map((line, i) => (
                <div key={`head-${i}`} className={styles.terminalLine}>
                  {parseAnsi(line)}
                </div>
              ))}
              <div className={styles.terminalMidFoldBarWrapper}>
                <Button
                  type="button"
                  variant="ghost"
                  className={styles.terminalMidFoldBar}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsFullExpanded(true);
                  }}
                  aria-label={`展开中间剩余 ${lines.length - (TERMINAL_HEAD_LINES + TERMINAL_TAIL_LINES)} 行日志输出`}
                >
                  <span className={styles.midFoldIcon} aria-hidden="true">
                    ⤢
                  </span>
                  <span>
                    +
                    {lines.length - (TERMINAL_HEAD_LINES + TERMINAL_TAIL_LINES)}{' '}
                    lines
                  </span>
                </Button>
              </div>
              {lines.slice(-TERMINAL_TAIL_LINES).map((line, i) => (
                <div key={`tail-${i}`} className={styles.terminalLine}>
                  {parseAnsi(line)}
                </div>
              ))}
            </>
          ) : (
            <>
              {lines.map((line, i) => (
                <div key={`line-${i}`} className={styles.terminalLine}>
                  {parseAnsi(line)}
                </div>
              ))}
              {lines.length > TERMINAL_FOLD_THRESHOLD && isFullExpanded && (
                <div className={styles.terminalMidFoldBarWrapper}>
                  <Button
                    type="button"
                    variant="ghost"
                    className={styles.terminalCollapseBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsFullExpanded(false);
                    }}
                    aria-label="收起中间日志输出"
                  >
                    <span>收起</span>
                  </Button>
                </div>
              )}
            </>
          )}
        </pre>
      </div>
    </div>
  );
};

export const TerminalCard = ModernTerminalToolCall;
