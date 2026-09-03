import React, { useState } from 'react';
import { Code2, Check, Copy } from 'lucide-react';
import styles from './ModernToolCall.module.css';

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
          <Code2 size={13} strokeWidth={2} />
          <span>{filename}</span>
        </div>
        <button
          type="button"
          className={styles.codeBlockCopyBtn}
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <Check size={12} strokeWidth={2.4} style={{ color: '#10b981' }} />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy size={12} strokeWidth={2} />
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
