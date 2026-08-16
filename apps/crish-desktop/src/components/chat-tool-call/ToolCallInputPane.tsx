import React, { useState, useMemo } from 'react';
import { Copy, Check, Code2, AlignLeft } from 'lucide-react';
import styles from './ChatToolCallBlock.module.css';
import { Button, Tooltip } from '../ui';
import {
  parseToolArgsSafe,
  isShellToolName,
  type ExtractedToolArgs,
} from '../../api/toolPresentation';

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

  return (
    <section
      className={`${styles.toolSection} ${styles.toolSectionInput}`}
      aria-label="工具输入参数"
      data-tool-id={toolId}
    >
      <header className={styles.toolSectionHeader}>
        <div className={styles.toolSectionTitleGroup}>
          <span className={styles.toolSectionBadge}>📥 输入</span>
          <span className={styles.toolSectionKind}>
            {shellTool ? '命令行指令' : '入参配置'}
          </span>
        </div>
        <div className={styles.toolSectionActions}>
          {hasProps && !shellTool ? (
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
          <Tooltip
            content={
              copied ? '已复制！' : shellTool ? '复制完整命令' : '复制入参 JSON'
            }
          >
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
        {shellTool ? (
          <div className={styles.toolCommandBlock}>
            <div className={styles.terminalLine}>
              <span className={styles.terminalPrompt} aria-hidden>
                $
              </span>
              <pre className={styles.toolResultPreCmd}>
                {parsedArgs.primaryTarget || argumentsStr || '(无命令)'}
              </pre>
            </div>
            {parsedArgs.props.cwd ? (
              <div className={styles.toolMetaParam}>
                <span className={styles.toolMetaKey}>工作目录:</span>
                <span className={styles.toolMetaVal}>
                  {String(parsedArgs.props.cwd)}
                </span>
              </div>
            ) : null}
          </div>
        ) : viewMode === 'raw' || !hasProps ? (
          <pre className={styles.toolInputCode}>{argumentsStr || '{}'}</pre>
        ) : (
          <div className={styles.toolKeyValueTable}>
            {Object.entries(parsedArgs.rawObject!).map(([key, val]) => {
              const valStr =
                typeof val === 'object'
                  ? JSON.stringify(val, null, 2)
                  : String(val);
              const isLong = valStr.length > 80 || valStr.includes('\n');
              return (
                <div key={key} className={styles.toolKeyValueRow}>
                  <span className={styles.toolKeyCell}>{key}</span>
                  <div className={styles.toolValCell}>
                    {isLong ? (
                      <pre className={styles.toolValPre}>{valStr}</pre>
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
