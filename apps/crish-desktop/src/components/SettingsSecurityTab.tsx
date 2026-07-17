/**
 * 设置 · 安全：权限模式、工作区与可自动放行的命令；成功静默，仅错误提示。
 */
import React, { useId, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './settings/SettingsUI';
import { useLayoutStore } from '../store/layoutStore';
import { getWorkspacePath, listProjects } from '../api/projectStore';
import {
  PERMISSION_MODES,
  coercePermissionMode,
  permissionModeMeta,
  transitionPermissionMode,
  type PermissionMode,
} from '../api/permissionModes';
import {
  classifyShellRisk,
  sanitizeWhitelistEntry,
  type ShellRiskLevel,
} from '../api/commandPermissions';
import { SettingsSelect } from './SettingsSelect';

type Props = {
  onShowToast: (msg: string) => void;
};

/** 常用只读命令 */
const QUICK_WHITELIST_CMDS = [
  'git status',
  'git diff',
  'git log',
  'npm test',
  'npm run typecheck',
] as const;

const WHITELIST_MATCH_HINT =
  '按整条命令匹配；后面可带参数，不会误伤相似命令名';

const WHITELIST_LOCAL_HINT =
  '匹配后本机可自动放行，不会伪造命令结果';

/** 风险短标签 */
const RISK_LABEL_ZH: Record<ShellRiskLevel, string> = {
  safe: '较安全',
  low: '较低风险',
  medium: '中等风险',
  high: '高风险',
  critical: '极高风险',
  unknown: '未知',
};

/** 路径短名 */
function pathLeaf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** 高风险命令不可加入 */
function isBlockedWhitelistRisk(level: ShellRiskLevel, hardDeny: boolean): boolean {
  return hardDeny || level === 'critical' || level === 'high';
}

export const SettingsSecurityTab: React.FC<Props> = ({ onShowToast }) => {
  const permissionModeRaw = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const commandPermissions = useLayoutStore((s) => s.commandPermissions);
  const addCommandPermissionStore = useLayoutStore((s) => s.addCommandPermission);
  const removeCommandPermissionStore = useLayoutStore((s) => s.removeCommandPermission);
  const setCommandPermissions = useLayoutStore((s) => s.setCommandPermissions);
  const [newWhitelistCmd, setNewWhitelistCmd] = useState('');

  const permLabelId = useId();
  const wlInputId = useId();

  // 非法权限值回落 ask
  const permissionMode = useMemo(() => {
    try {
      return coercePermissionMode(permissionModeRaw);
    } catch {
      return 'ask' as PermissionMode;
    }
  }, [permissionModeRaw]);
  const permissionMeta = useMemo(() => permissionModeMeta(permissionMode), [permissionMode]);

  const workspacePaths = useMemo(() => {
    try {
      const workspacePath = getWorkspacePath();
      return workspacePath
        ? [workspacePath]
        : listProjects()
            .slice(0, 3)
            .map((p) => p.path);
    } catch {
      return [] as string[];
    }
  }, []);

  const whitelist = useMemo(() => {
    const raw = commandPermissions || [];
    const cleaned = raw
      .map((x) => sanitizeWhitelistEntry(x))
      .filter(Boolean);
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const cmd of cleaned) {
      const key = cmd.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(cmd);
    }
    return deduped.slice().sort((a, b) => a.localeCompare(b, 'zh'));
  }, [commandPermissions]);

  const draftRisk = useMemo(
    () => classifyShellRisk(newWhitelistCmd.trim() ? newWhitelistCmd : ''),
    [newWhitelistCmd],
  );
  const draftTrimmed = newWhitelistCmd.trim();
  const draftBlocked =
    Boolean(draftTrimmed) && isBlockedWhitelistRisk(draftRisk.level, draftRisk.hardDeny);

  const addWhitelist = (raw?: string) => {
    const source = raw ?? newWhitelistCmd;
    try {
      const cmd = sanitizeWhitelistEntry(source);
      if (!cmd) {
        // 有输入却被规范掉：错误 toast；空输入静默
        if (source.trim()) onShowToast('无效命令');
        return;
      }
      const risk = classifyShellRisk(cmd);
      if (isBlockedWhitelistRisk(risk.level, risk.hardDeny)) {
        onShowToast(`不可加入白名单：${risk.message}`);
        return;
      }
      const exists = whitelist.some(
        (x) => sanitizeWhitelistEntry(x).toLowerCase() === cmd.toLowerCase(),
      );
      if (exists) return; // 已存在：成功静默
      addCommandPermissionStore(cmd);
      if (!raw) setNewWhitelistCmd('');
    } catch (err) {
      onShowToast('添加失败：' + String(err));
    }
  };

  const removeWhitelist = (cmd: string) => {
    try {
      removeCommandPermissionStore(cmd);
    } catch (err) {
      onShowToast('移除失败：' + String(err));
    }
  };

  const clearWhitelist = () => {
    if (whitelist.length === 0) return;
    const ok =
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(
            `确定清空全部 ${whitelist.length} 条白名单？\n仅影响本机审批快捷放行，无法撤销。`,
          )
        : true;
    if (!ok) return;
    try {
      setCommandPermissions([]);
    } catch (err) {
      onShowToast('清空失败：' + String(err));
    }
  };

  const onPermissionChange = (v: string) => {
    try {
      const next = transitionPermissionMode(permissionMode, v);
      // 已是目标模式：跳过写 store，避免无意义重置 planApproved
      if (next === permissionMode) return;
      setPermissionMode(next as PermissionMode);
    } catch (err) {
      onShowToast('权限切换失败：' + String(err));
    }
  };

  const permissionTitle = `${permissionMeta.label}：${permissionMeta.description}`;

  const whitelistEmptyTitle = `${WHITELIST_MATCH_HINT}；${WHITELIST_LOCAL_HINT}`;

  const inputRiskTitle = draftTrimmed
    ? `${RISK_LABEL_ZH[draftRisk.level]}：${draftRisk.message} · 回车添加`
    : `${WHITELIST_MATCH_HINT} · 回车添加`;

  const permissionOptions = useMemo(
    () =>
      PERMISSION_MODES.map((m) => ({
        value: m.id,
        label: m.label,
        // 下拉副文案：一句人话，不塞引擎码
        hint: m.description,
      })),
    [],
  );

  return (
    <SettingsPage title="安全">
      <SettingsSection title="权限">
        <SettingsCard>
          <SettingsRow
            title={<span id={`${permLabelId}-row`}>权限模式</span>}
            desc="工具执行前要不要先确认"
            control={
              <SettingsSelect
                className="settings-security-select"
                value={permissionMode}
                options={permissionOptions}
                onChange={onPermissionChange}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="工作区">
        <SettingsCard>
          {workspacePaths.length > 0 ? (
            workspacePaths.map((path) => {
              const leaf = pathLeaf(path);
              return (
                <SettingsRow
                  key={path}
                  title={<span className="settings-path-ellipsis" title={path}>{leaf}</span>}
                  desc={<span className="settings-security-path">{path}</span>}
                />
              );
            })
          ) : (
            <SettingsRow
              title={<span className="settings-list-empty">未打开项目</span>}
              desc="打开项目后会显示在这里"
            />
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="信任命令">
        <SettingsCard>
          <div style={{ display: 'flex', gap: '16px', padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)', alignItems: 'center' }}>
            <div style={{ width: '120px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label htmlFor={wlInputId} style={{ fontSize: '14px', color: 'var(--text-primary)' }}>添加命令</label>
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>匹配后可自动放行</span>
            </div>
            <div style={{ flex: 1, display: 'flex', gap: '8px' }}>
              <input
                id={wlInputId}
                type="text"
                placeholder="如 git status"
                value={newWhitelistCmd}
                onChange={(e) => setNewWhitelistCmd(e.target.value)}
                className="settings-field-input settings-field-input--sm settings-field-input--grow"
                title={inputRiskTitle}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                aria-label="要信任的命令"
                aria-invalid={draftBlocked || undefined}
                style={{ flex: 1 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addWhitelist();
                  } else if (e.key === 'Escape' && newWhitelistCmd) {
                    e.preventDefault();
                    setNewWhitelistCmd('');
                  }
                }}
              />
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                title={
                  draftBlocked
                    ? `不可添加：${draftRisk.message}`
                    : draftTrimmed
                      ? '加入白名单'
                      : '请输入命令'
                }
                aria-label="添加命令"
                disabled={!draftTrimmed || draftBlocked}
                onClick={() => addWhitelist()}
                style={{ borderRadius: '6px' }}
              >
                添加
              </button>
              {whitelist.length > 0 ? (
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  title={`清空全部 ${whitelist.length} 条（需确认）`}
                  aria-label={`清空全部 ${whitelist.length} 条白名单`}
                  onClick={clearWhitelist}
                  style={{ borderRadius: '6px' }}
                >
                  清空
                </button>
              ) : null}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '16px', padding: '16px 20px' }}>
            <div style={{ width: '120px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>常用预设</span>
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>点击一键加入信任</span>
            </div>
            <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {QUICK_WHITELIST_CMDS.map((cmd) => {
                const already = whitelist.some(
                  (x) => sanitizeWhitelistEntry(x).toLowerCase() === cmd.toLowerCase(),
                );
                return (
                  <button
                    key={cmd}
                    type="button"
                    className="settings-chip-btn"
                    disabled={already}
                    aria-pressed={already}
                    aria-label={already ? `${cmd} 已添加` : `添加 ${cmd}`}
                    title={already ? '已添加' : `添加 ${cmd}`}
                    onClick={() => addWhitelist(cmd)}
                    style={{ height: '28px', padding: '0 10px', fontSize: '12px', borderRadius: '6px' }}
                  >
                    {cmd}
                  </button>
                );
              })}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={`已信任命令 (${whitelist.length})`}>
        <SettingsCard>
          {whitelist.length === 0 ? (
            <SettingsRow
              title={<span className="settings-list-empty">还没有信任的命令</span>}
              desc="上方输入命令并添加，或点击常用预设"
            />
          ) : (
            whitelist.map((cmd) => {
              const risk = classifyShellRisk(cmd);
              const riskTag = RISK_LABEL_ZH[risk.level];
              return (
                <SettingsRow
                  key={cmd}
                  title={<span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }}>{cmd}</span>}
                  desc={`${riskTag} · ${risk.message}`}
                  control={
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm danger"
                      onClick={() => removeWhitelist(cmd)}
                      title={`移除 ${cmd}`}
                      aria-label={`移除 ${cmd}`}
                    >
                      <Lucide.Trash2 size={14} aria-hidden />
                    </button>
                  }
                />
              );
            })
          )}
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
};
