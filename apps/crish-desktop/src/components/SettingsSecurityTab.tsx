/**
 * 设置 · 安全（现代化列表：权限模式、工作目录、命令白名单）
 */
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import { getWorkspacePath, listProjects } from '../api/projectStore';
import { PERMISSION_MODES, type PermissionMode } from '../api/permissionModes';

type Props = {
  onShowToast: (msg: string) => void;
};

/** 常用只读/低风险命令，一键加入白名单 */
const QUICK_WHITELIST_CMDS = [
  'git status',
  'git diff',
  'git log',
  'npm test',
  'npm run typecheck',
] as const;

export const SettingsSecurityTab: React.FC<Props> = ({ onShowToast }) => {
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const commandPermissions = useLayoutStore((s) => s.commandPermissions);
  const addCommandPermissionStore = useLayoutStore((s) => s.addCommandPermission);
  const removeCommandPermissionStore = useLayoutStore((s) => s.removeCommandPermission);
  const setCommandPermissions = useLayoutStore((s) => s.setCommandPermissions);
  const [newWhitelistCmd, setNewWhitelistCmd] = useState('');

  const permissionDesc =
    PERMISSION_MODES.find((m) => m.id === permissionMode)?.description ?? '';
  const workspacePath = getWorkspacePath();
  const workspacePaths = workspacePath
    ? [workspacePath]
    : listProjects()
        .slice(0, 3)
        .map((p) => p.path);

  const whitelist = commandPermissions || [];

  const addWhitelist = (raw?: string) => {
    const cmd = (raw ?? newWhitelistCmd).trim();
    if (!cmd) return;
    if (whitelist.some((x) => x === cmd)) {
      onShowToast(`已在白名单：${cmd}`);
      return;
    }
    addCommandPermissionStore(cmd);
    onShowToast(`已添加：${cmd}`);
    if (!raw) setNewWhitelistCmd('');
  };

  const clearWhitelist = () => {
    if (whitelist.length === 0) return;
    setCommandPermissions([]);
    onShowToast('已清空命令白名单');
  };

  const copyPath = (path: string) => {
    void navigator.clipboard.writeText(path).then(
      () => onShowToast('已复制路径'),
      () => onShowToast('复制失败'),
    );
  };

  return (
    <div className="settings-pane settings-pane--modern">
      <header className="settings-page-head">
        <h2 className="settings-page-title">安全</h2>
        <p className="settings-page-desc">
          命令权限与敏感操作（打开项目即表示信任该目录）
        </p>
      </header>

      <section className="settings-group" aria-label="权限">
        <div className="settings-group-label">权限</div>
        <div className="settings-list">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">默认权限</div>
              <div className="settings-list-sub">
                {permissionDesc}
                {' '}
                极危命令在「自动 / 完全访问」下仍会征求确认；「计划」模式禁止改文件。
              </div>
            </div>
            <div className="settings-list-stack-controls">
              <div className="ui-segment ui-segment--inline settings-segment-pill">
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
            </div>
          </div>
        </div>
        <div className="settings-feature" style={{ marginTop: 16 }}>
          <div className="settings-feature-title">计划 vs 自动</div>
          <div className="settings-feature-body">
            「计划」只读规划、不改项目代码；「完全访问」可自动读写与网络，破坏性操作与极危仍会确认。
            日常改码更常用「需确认」：读码顺畅，写入前征求同意。
          </div>
        </div>
      </section>

      <section className="settings-group" aria-label="当前工作目录">
        <div className="settings-group-label">当前工作目录</div>
        <div className="settings-list settings-list--spaced">
          {workspacePaths.length > 0 ? (
            workspacePaths.map((path) => (
              <div key={path} className="settings-list-row">
                <div className="settings-list-copy">
                  <div className="settings-list-sub settings-list-sub--mono" title={path}>
                    {path}
                  </div>
                </div>
                <div className="settings-list-control">
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    onClick={() => copyPath(path)}
                    title="复制路径"
                    aria-label={`复制路径 ${path}`}
                  >
                    <Lucide.Copy size={14} strokeWidth={1.75} />
                    复制
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="settings-list-row">
              <div className="settings-list-copy">
                <div className="settings-list-sub">
                  尚未选择项目。可在空对话页的「选择项目」中添加。
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="settings-group" aria-label="命令白名单">
        <div className="settings-group-label">命令白名单</div>
        <div className="settings-list">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">自动允许</div>
              <div className="settings-list-sub">
                当引擎请求确认时，若命令以前缀匹配白名单，将自动批准并继续执行（不伪造结果）。
                建议只加只读/低风险命令。完全访问模式仍由引擎处理非极危操作；白名单是「需确认」下的顺手加速。
              </div>
            </div>
            <div className="settings-list-stack-controls">
              {whitelist.length > 0 ? (
                <div className="settings-list-stack-actions">
                  {whitelist.map((cmd) => (
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
                        aria-label={`移除 ${cmd}`}
                      >
                        <Lucide.X size={14} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="settings-list-stack-actions">
                {QUICK_WHITELIST_CMDS.map((cmd) => {
                  const already = whitelist.some((x) => x === cmd);
                  return (
                    <button
                      key={cmd}
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      disabled={already}
                      title={already ? '已在白名单' : `添加 ${cmd}`}
                      onClick={() => addWhitelist(cmd)}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        opacity: already ? 0.45 : 1,
                      }}
                    >
                      {cmd}
                    </button>
                  );
                })}
              </div>

              <div className="settings-list-stack-actions">
                <input
                  type="text"
                  placeholder="例如：git status"
                  value={newWhitelistCmd}
                  onChange={(e) => setNewWhitelistCmd(e.target.value)}
                  className="settings-field-input"
                  style={{ flex: 1, minWidth: 160 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addWhitelist();
                  }}
                />
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => addWhitelist()}
                >
                  添加
                </button>
                {whitelist.length > 0 ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    onClick={clearWhitelist}
                  >
                    清空全部
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
