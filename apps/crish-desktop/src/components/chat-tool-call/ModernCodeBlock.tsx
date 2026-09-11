import React, { useState } from 'react';

import styles from './ModernToolCall.module.css';
import { AppIcon } from '../ui/icons/index';

export interface ModernCodeBlockProps {
  filename?: string;
  code: string;
  className?: string;
}

/**
 * 极简纯净代码块卡片（1:1 对齐用户截图 3 设计）
 * 包含：语言/文件标签 + 一键复制 + 行号 + 等宽代码
 */
export const ModernCodeBlock: React.FC<ModernCodeBlockProps> = ({
  filename = 'code.ts',
  code,
  className = '',
}) => {
  const [copied, setCopied] = useState(false);

  const lines = code.split('\n');

  const handleCopy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={`${styles.codeBlockCard} ${className}`}>
      <div className={styles.codeBlockHead}>
        <div className={styles.codeBlockTag}>
          <AppIcon name="code" size={13} />
          <span>{filename}</span>
        </div>
        <button
          type="button"
          className={styles.codeBlockCopyBtn}
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <AppIcon name="check" size={12} className={styles.copiedCheckIcon} />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <AppIcon name="copy" size={12} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      <div className={styles.codeBlockBody}>
        <div className={styles.codeBlockLinenums}>
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <pre className={styles.codeBlockPre}>{code}</pre>
      </div>
    </div>
  );
};
