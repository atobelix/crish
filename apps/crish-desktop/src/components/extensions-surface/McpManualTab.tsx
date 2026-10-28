import React from 'react';
import { Input, Button, Select, Textarea } from '@/components/ui';
import { PRESET_TEMPLATES, type PresetItem } from './mcpConnectTypes';
import styles from './McpConnectModal.module.css';

export interface McpManualTabProps {
  name: string;
  setName: (v: string) => void;
  type: 'stdio' | 'sse';
  setType: (v: 'stdio' | 'sse') => void;
  command: string;
  setCommand: (v: string) => void;
  args: string;
  setArgs: (v: string) => void;
  env: string;
  setEnv: (v: string) => void;
  url: string;
  setUrl: (v: string) => void;
  onApplyPreset: (preset: PresetItem) => void;
}

export const McpManualTab: React.FC<McpManualTabProps> = ({
  name,
  setName,
  type,
  setType,
  command,
  setCommand,
  args,
  setArgs,
  env,
  setEnv,
  url,
  setUrl,
  onApplyPreset,
}) => {
  return (
    <div className={styles.formSection}>
      {/* 常用预设模板栏 */}
      <div className={styles.presetBar}>
        <span className={styles.presetLabel}>常用预设模板：</span>
        {PRESET_TEMPLATES.map((p) => (
          <Button
            key={p.id}
            variant="secondary"
            size="sm"
            className={styles.presetBtn}
            onClick={() => onApplyPreset(p)}
          >
            {p.name}
          </Button>
        ))}
      </div>

      <div className={styles.formGrid}>
        <div className={styles.formField}>
          <label className={styles.fieldLabel}>服务名称</label>
          <Input
            size="sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 sqlite / filesystem"
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.fieldLabel}>传输协议</label>
          <Select
            value={type}
            options={[
              { id: 'stdio', label: 'stdio (标准管道进程)' },
              { id: 'sse', label: 'sse (Server-Sent Events HTTP)' },
            ]}
            onChange={(val) => setType(val as 'stdio' | 'sse')}
          />
        </div>

        {type === 'stdio' ? (
          <>
            <div className={styles.formField}>
              <label className={styles.fieldLabel}>启动命令 (command)</label>
              <Input
                size="sm"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="如 npx, uvx, python"
              />
            </div>

            <div className={styles.formField}>
              <label className={styles.fieldLabel}>
                <span>运行参数 (args)</span>
              </label>
              <Input
                size="sm"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="如 -y @modelcontextprotocol/server-filesystem"
              />
            </div>

            <div className={styles.formFieldFull}>
              <label className={styles.fieldLabel}>
                <span>环境变量 (env)</span>
              </label>
              <Textarea
                className={styles.textareaField}
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                placeholder="DEBUG=1&#10;API_KEY=sk_test_..."
              />
            </div>
          </>
        ) : (
          <div className={styles.formFieldFull}>
            <label className={styles.fieldLabel}>端点 URL</label>
            <Input
              size="sm"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:8000/sse"
            />
          </div>
        )}
      </div>
    </div>
  );
};
