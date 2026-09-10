import React, { useState, useMemo } from 'react';
import { Copy, Check, Code2, AlignLeft } from 'lucide-react';
import styles from './ChatToolCallBlock.module.css';
import { Button, Tooltip } from '../ui';
import {
  parseToolArgsSafe,
  isShellToolName,
  type ExtractedToolArgs,
} from '../../api/toolPresentation';

const TOOL_INPUT_LINE_CAP = 1000;
const TOOL_INPUT_BYTE_CAP = 128 * 1024;

/**
 * 入参 1000 行 / 128KB 防爆截断保护
 */
function budgetInputText(text: string): {
  displayText: string;
  isTruncated: boolean;
} {
  if (!text) return { displayText: '', isTruncated: false };
  const lines = text.split('\n');
  const bytes =
    typeof Blob !== 'undefined' ? new Blob([text]).size : text.length;
  if (lines.length <= TOOL_INPUT_LINE_CAP && bytes <= TOOL_INPUT_BYTE_CAP) {
    return { displayText: text, isTruncated: false };
  }
  let sliced = lines.slice(0, TOOL_INPUT_LINE_CAP).join('\n');
  if (sliced.length > TOOL_INPUT_BYTE_CAP) {
    sliced = sliced.slice(0, TOOL_INPUT_BYTE_CAP);
  }
  return {
    displayText: `${sliced}\n… [入参过长，已截断显示前 ${TOOL_INPUT_LINE_CAP} 行 / 128 KB]`,
    isTruncated: true,
  };
}

export interface ToolCallInputPaneProps {
  toolId?: string;
  name?: string;
  argumentsStr?: string;
}

export const ToolCallInputPane: React.FC<ToolCallInputPaneProps> = ({
  toolId,
  name = 'tool',
  argumentsStr = '',
}) => {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');

  const shellTool = useMemo(() => isShellToolName(name), [name]);
  const parsedArgs = useMemo<ExtractedToolArgs>(
    () => parseToolArgsSafe(argumentsStr),
    [argumentsStr]
  );

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy =
      shellTool && parsedArgs.primaryTarget
        ? parsedArgs.primaryTarget
        : argumentsStr;
    if (textToCopy) {
      void navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const hasProps =
    parsedArgs.isObject &&
    parsedArgs.rawObject &&
    Object.keys(parsedArgs.rawObject).length > 0;

  const rawDisplay = useMemo(
    () => budgetInputText(argumentsStr || '{}').displayText,
    [argumentsStr]
  );

  const commandDisplay = useMemo(
    () =>
      budgetInputText(parsedArgs.primaryTarget || argumentsStr || '(无命令)')
        .displayText,
    [parsedArgs.primaryTarget, argumentsStr]
  );

  if (shellTool) {
    return (
      <section
        className={`${styles.toolSection} ${styles.toolSectionInput} ${styles.toolSectionShellSingleLine}`}
        aria-label="终端命令输入"
        data-tool-id={toolId}
      >
        <div className={styles.terminalSingleLineRow}>
          <div className={styles.terminalLine}>
            <span className={styles.terminalPrompt} aria-hidden>
              $
            </span>
            <pre className={styles.toolResultPreCmd}>{commandDisplay}</pre>
          </div>
          <div className={styles.terminalLineEndSlot}>
            {parsedArgs.props.cwd ? (
              <Tooltip content={String(parsedArgs.props.cwd)}>
                <span className={styles.terminalCwdBadge}>
                  ({String(parsedArgs.props.cwd)})
                </span>
              </Tooltip>
            ) : null}
            <Tooltip content={copied ? '已复制！' : '复制完整命令'}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.toolSectionActionBtn}
                onClick={handleCopy}
                icon={
                  copied ? (
                    <Check size={12} className={styles.copiedIcon} />
                  ) : (
                    <Copy size={12} />
                  )
                }
              >
                {copied ? '已复制' : '复制'}
              </Button>
            </Tooltip>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`${styles.toolSection} ${styles.toolSectionInput}`}
      aria-label="工具输入参数"
      data-tool-id={toolId}
    >
      <header className={styles.toolSectionHeader}>
        <div className={styles.toolSectionTitleGroup}>
          <span className={styles.toolSectionBadge}>输入</span>
        </div>
        <div className={styles.toolSectionActions}>
          {hasProps ? (
            <Tooltip
              content={
                viewMode === 'formatted' ? '查看原始 JSON' : '查看结构化表'
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.toolSectionActionBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  setViewMode((m) => (m === 'formatted' ? 'raw' : 'formatted'));
                }}
                icon={
                  viewMode === 'formatted' ? (
                    <Code2 size={12} />
                  ) : (
                    <AlignLeft size={12} />
                  )
                }
              />
            </Tooltip>
          ) : null}
          <Tooltip content={copied ? '已复制！' : '复制入参 JSON'}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.toolSectionActionBtn}
              onClick={handleCopy}
              icon={
                copied ? (
                  <Check size={12} className={styles.copiedIcon} />
                ) : (
                  <Copy size={12} />
                )
              }
            >
              {copied ? '已复制' : '复制'}
            </Button>
          </Tooltip>
        </div>
      </header>

      <div className={styles.toolSectionContent}>
        {viewMode === 'raw' || !hasProps ? (
          <pre className={styles.toolInputCode}>{rawDisplay}</pre>
        ) : (
          <div className={styles.toolKeyValueTable}>
            {Object.entries(parsedArgs.rawObject!).map(([key, val]) => {
              const valStr =
                typeof val === 'object'
                  ? JSON.stringify(val, null, 2)
                  : String(val);
              const budgeted = budgetInputText(valStr);
              const isLong =
                valStr.length > 80 ||
                valStr.includes('\n') ||
                budgeted.isTruncated;
              return (
                <div key={key} className={styles.toolKeyValueRow}>
                  <span className={styles.toolKeyCell}>{key}</span>
                  <div className={styles.toolValCell}>
                    {isLong ? (
                      <pre className={styles.toolValPre}>
                        {budgeted.displayText}
                      </pre>
                    ) : (
                      <span className={styles.toolValText}>{valStr}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
