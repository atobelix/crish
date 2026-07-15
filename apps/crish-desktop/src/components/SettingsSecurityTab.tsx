/**
 * 设置 · 安全：默认权限模式、工作目录、命令白名单
 */
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import { getWorkspacePath, listProjects } from '../api/projectStore';
import { PERMISSION_MODES, type PermissionMode } from '../api/permissionModes';

type Props = {
  onShowToast: (msg: string) => void;
};

export const SettingsSecurityTab: React.FC<Props> = ({ onShowToast }) => {
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const commandPermissions = useLayoutStore((s) => s.commandPermissions);
  const addCommandPermissionStore = useLayoutStore((s) => s.addCommandPermission);
  const removeCommandPermissionStore = useLayoutStore((s) => s.removeCommandPermission);
  const [newWhitelistCmd, setNewWhitelistCmd] = useState('');

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>安全</h4>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
          命令权限与敏感操作（打开项目即表示信任该目录）
        </p>
      </div>

      <div className="settings-fields-stack" style={{ gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="settings-field-label">默认权限</label>
          <div className="ui-segment" style={{ maxWidth: 420, flexWrap: 'wrap' }}>
            {PERMISSION_MODES.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`ui-segment-item ${permissionMode === opt.id ? 'active' : ''}`}
                onClick={() => setPermissionMode(opt.id as PermissionMode)}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            {PERMISSION_MODES.find((m) => m.id === permissionMode)?.description}
            {' '}极危命令在「自动 / 完全访问」下仍会征求确认；「计划」模式禁止改文件。
          </p>
        </div>

        <div>
          <div className="settings-field-label" style={{ marginBottom: 8 }}>
            当前工作目录
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(getWorkspacePath()
              ? [getWorkspacePath()]
              : listProjects()
                  .slice(0, 3)
                  .map((p) => p.path)
            ).map((path) => (
              <div
                key={path}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    wordBreak: 'break-all',
                    paddingRight: 12,
                  }}
                >
                  {path}
                </span>
              </div>
            ))}
            {!getWorkspacePath() && listProjects().length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                尚未选择项目。可在空对话页的「选择项目」中添加。
              </span>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <div className="settings-field-label" style={{ marginBottom: 8 }}>
          命令白名单（自动允许）
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          当引擎请求确认时，若命令以前缀匹配白名单，将自动批准并继续执行（不伪造结果）。
          建议只加只读/低风险命令，例如 <code>git status</code>、<code>npm test</code>。
          完全访问模式仍由引擎处理非极危操作；白名单是「需确认」下的顺手加速。
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {(commandPermissions || []).map((cmd) => (
            <span
              key={cmd}
              className="ui-badge"
              style={{
                padding: '5px 8px',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
              }}
            >
              {cmd}
              <button
                type="button"
                onClick={() => {
                  removeCommandPermissionStore(cmd);
                  onShowToast(`已移除：${cmd}`);
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  color: 'var(--text-tertiary)',
                  display: 'inline-flex',
                  marginLeft: 4,
                  padding: 0,
                }}
              >
                <Lucide.X size={14} />
              </button>
            </span>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            placeholder="例如：git status"
            value={newWhitelistCmd}
            onChange={(e) => setNewWhitelistCmd(e.target.value)}
            className="settings-field-input"
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newWhitelistCmd.trim()) {
                addCommandPermissionStore(newWhitelistCmd.trim());
                onShowToast(`已添加：${newWhitelistCmd.trim()}`);
                setNewWhitelistCmd('');
              }
            }}
          />
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            onClick={() => {
              if (!newWhitelistCmd.trim()) return;
              const cmd = newWhitelistCmd.trim();
              addCommandPermissionStore(cmd);
              onShowToast(`已添加：${cmd}`);
              setNewWhitelistCmd('');
            }}
          >
            添加
          </button>
        </div>
      </div>
    </>
  );
};
