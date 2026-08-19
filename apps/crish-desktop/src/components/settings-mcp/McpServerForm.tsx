import { useToast } from '../../services/toast/ToastContext';
import React from 'react';
import styles from './McpSettingsTab.module.css';
import { Button, Input, Select, Tooltip } from '../ui';
import { isDemoTransport, transportTitle, type DemoTransport } from './types';

export type McpServerFormProps = {
  newName: string;
  newType: DemoTransport;
  newCmd: string;
  newArgs: string;
  newUrl: string;
  setNewName: (val: string) => void;
  setNewType: (val: DemoTransport) => void;
  setNewCmd: (val: string) => void;
  setNewArgs: (val: string) => void;
  setNewUrl: (val: string) => void;
  setShowAdd: (show: boolean) => void;
  onAddDemo: () => void;
};

export const McpServerForm: React.FC<McpServerFormProps> = ({
  newName,
  newType,
  newCmd,
  newArgs,
  newUrl,
  setNewName,
  setNewType,
  setNewCmd,
  setNewArgs,
  setNewUrl,
  setShowAdd,
  onAddDemo,
  }) => {
  const { showToast } = useToast();
  return (
    <div className={`${styles.mcpAddBox} mcp-add-box`} role="form" aria-label="注册演示服务">
      <div className={`${styles.mcpAddRow} ${styles.mcpAddRowCoverContent} mcp-add-row`}>
        <div className={styles.mcpAddField}>
          <Input
            size="sm"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="名称"
            aria-label="名称"
            aria-required
            autoFocus
          />
        </div>
        <Select
          className="mcp-add-type-select"
          value={newType}
          options={[
            {
              id: 'stdio',
              label: 'stdio',
              ...(transportTitle('stdio') !== undefined ? { hint: transportTitle('stdio') } : {}),
            },
            {
              id: 'sse',
              label: 'sse',
              ...(transportTitle('sse') !== undefined ? { hint: transportTitle('sse') } : {}),
            },
          ]}
          onChange={(v) => {
            if (isDemoTransport(v)) {
              setNewType(v);
            } else {
              showToast('未知的传输类型');
            }
          }}
        />
        {newType === 'stdio' ? (
          <>
            <Tooltip content="stdio 启动命令">
              <div className={styles.mcpAddField}>
                <Input
                  size="sm"
                  value={newCmd}
                  onChange={(e) => setNewCmd(e.target.value)}
                  placeholder="命令"
                  aria-label="启动命令"
                />
              </div>
            </Tooltip>
            <Tooltip content="参数（逗号分隔）">
              <div className={styles.mcpAddField}>
                <Input
                  size="sm"
                  value={newArgs}
                  onChange={(e) => setNewArgs(e.target.value)}
                  placeholder="参数（逗号分隔）"
                  aria-label="参数，逗号分隔"
                />
              </div>
            </Tooltip>
          </>
        ) : (
          <Tooltip content="SSE 端点地址">
            <div className={`${styles.mcpAddField} ${styles.mcpAddUrl}`}>
              <Input
                size="sm"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="端点 URL"
                aria-label="端点 URL"
              />
            </div>
          </Tooltip>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAdd(false)}
          aria-label="取消添加"
        >
          取消
        </Button>
        <Tooltip content={!newName.trim() ? '请先填写名称' : '保存到本地演示列表'}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!newName.trim()}
            onClick={() => void onAddDemo()}
            aria-label="保存演示服务"
          >
            保存
          </Button>
        </Tooltip>
      </div>
    </div>
  );
};
