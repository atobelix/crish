import React from 'react';
import { Button, Textarea } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import styles from './McpConnectModal.module.css';

export interface McpSyntaxTabProps {
  json: string;
  setJson: (v: string) => void;
  error: string | null;
  info: string | null;
  onResetDemo: () => void;
}

export const McpSyntaxTab: React.FC<McpSyntaxTabProps> = ({
  json,
  setJson,
  error,
  info,
  onResetDemo,
}) => {
  return (
    <div className={styles.syntaxContainer}>
      <div className={styles.syntaxHeader}>
        <span className={styles.syntaxTips}>
          支持标准 JSON、单服务配置，或 Claude Desktop / Cursor 的 mcpServers
          片段
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={styles.presetBtn}
          onClick={onResetDemo}
        >
          重置示例
        </Button>
      </div>

      <Textarea
        className={styles.syntaxTextarea}
        value={json}
        onChange={(e) => setJson(e.target.value)}
        placeholder="粘贴或编写 JSON 配置..."
        spellCheck={false}
      />

      {error ? (
        <div className={`${styles.validationBanner} ${styles.validationError}`}>
          <AppIcon name="alert-circle" size={14} />
          <span>语法错误：{error}</span>
        </div>
      ) : info ? (
        <div
          className={`${styles.validationBanner} ${styles.validationSuccess}`}
        >
          <AppIcon name="check" size={14} />
          <span>{info}</span>
        </div>
      ) : null}
    </div>
  );
};
