/**
 * 设置 · 安全：权限模式、工作区与可自动放行的命令；成功静默，仅错误提示。
 */
import React, { useId, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './SettingsSecurityTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  Tooltip,
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
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showAllPaths, setShowAllPaths] = useState(false);

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
        : listProjects().map((p) => p.path);
    } catch {
      return [] as string[];
    }
  }, []);

  const visiblePaths = useMemo(() => {
    if (workspacePaths.length <= 5 || showAllPaths) return workspacePaths;
    return workspacePaths.slice(0, 5);
  }, [workspacePaths, showAllPaths]);

  const extraCount = workspacePaths.length - 5;

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
      if (exists) return;
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

  const doClearWhitelist = () => {
    try {
      setCommandPermissions([]);
      setShowClearConfirm(false);
    } catch (err) {
      onShowToast('清空失败：' + String(err));
    }
  };

  const onPermissionChange = (v: string) => {
    try {
      const next = transitionPermissionMode(permissionMode, v);
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
            <>
              {visiblePaths.map((path) => {
                const leaf = pathLeaf(path);
                return (
                  <SettingsRow
                    key={path}
                    title={<span className="settings-path-ellipsis" title={path}>{leaf}</span>}
                    desc={<span className="settings-security-path">{path}</span>}
                  />
                );
              })}
              {extraCount > 0 && !showAllPaths ? (
                <div style={{ padding: '8px 20px' }}>
                  <button
                    type="button"
                    className="settings-chip-btn"
                    onClick={() => setShowAllPaths(true)}
                  >
                    +{extraCount} 更多
                  </button>
                </div>
              ) : null}
              {showAllPaths && extraCount > 0 ? (
                <div style={{ padding: '8px 20px' }}>
                  <button
                    type="button"
                    className="settings-chip-btn"
                    onClick={() => setShowAllPaths(false)}
                  >
                    收起
                  </button>
                </div>
              ) : null}
            </>
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
          <div className={styles.wlRow}>
            <div className={styles.labelCol}>
              <label htmlFor={wlInputId} className={styles.labelTitle}>添加命令</label>
              <span className={styles.labelDesc}>匹配后可自动放行</span>
            </div>
            <div className={styles.inputGroup}>
              <input
                id={wlInputId}
                type="text"
                placeholder="如 git status"
                value={newWhitelistCmd}
                onChange={(e) => setNewWhitelistCmd(e.target.value)}
                title={inputRiskTitle}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                aria-label="要信任的命令"
                aria-invalid={draftBlocked || undefined}
                className={`settings-field-input settings-field-input--sm settings-field-input--grow ${styles.inputGrow}`}
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
              <Tooltip content={
                draftBlocked
                  ? `不可添加：${draftRisk.message}`
                  : draftTrimmed
                    ? '加入白名单'
                    : '请输入命令'
              }>
                <button
                  type="button"
                  className={`ui-btn ui-btn-secondary ui-btn-sm ${styles.actionBtn}`}
                  aria-label="添加命令"
                  disabled={!draftTrimmed || draftBlocked}
                  onClick={() => addWhitelist()}
                >
                  添加
                </button>
              </Tooltip>
              {whitelist.length > 0 && !showClearConfirm ? (
                <Tooltip content={`清空全部 ${whitelist.length} 条（需确认）`}>
                  <button
                    type="button"
                    className={`ui-btn ui-btn-ghost ui-btn-sm ${styles.actionBtn}`}
                    aria-label={`清空全部 ${whitelist.length} 条白名单`}
                    onClick={() => setShowClearConfirm(true)}
                  >
                    清空
                  </button>
                </Tooltip>
              ) : null}
              {showClearConfirm ? (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                    确定清除所有白名单命令？此操作不可撤销
                  </span>
                  <button
                    type="button"
                    className={`ui-btn ui-btn-secondary ui-btn-sm ${styles.actionBtn}`}
                    onClick={doClearWhitelist}
                  >
                    确认
                  </button>
                  <button
                    type="button"
                    className={`ui-btn ui-btn-ghost ui-btn-sm ${styles.actionBtn}`}
                    onClick={() => setShowClearConfirm(false)}
                  >
                    取消
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className={styles.wlRowNoBorder}>
            <div className={styles.labelCol}>
              <span className={styles.labelTitle}>常用预设</span>
              <span className={styles.labelDesc}>点击一键加入信任</span>
            </div>
            <div className={styles.presetGroup}>
              {QUICK_WHITELIST_CMDS.map((cmd) => {
                const already = whitelist.some(
                  (x) => sanitizeWhitelistEntry(x).toLowerCase() === cmd.toLowerCase(),
                );
                return (
                  <Tooltip key={cmd} content={already ? '已添加' : `添加 ${cmd}`}>
                    <button
                      type="button"
                      className={`settings-chip-btn ${styles.presetChip}`}
                      disabled={already}
                      aria-pressed={already}
                      aria-label={already ? `${cmd} 已添加` : `添加 ${cmd}`}
                      onClick={() => addWhitelist(cmd)}
                    >
                      {cmd}
                    </button>
                  </Tooltip>
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
                  title={<span className={styles.cmdSpan}>{cmd}</span>}
                  desc={`${riskTag} · ${risk.message}`}
                  control={
                    <Tooltip content={`移除 ${cmd}`}>
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm danger"
                        onClick={() => removeWhitelist(cmd)}
                        aria-label={`移除 ${cmd}`}
                      >
                        <Lucide.Trash2 size={14} aria-hidden />
                      </button>
                    </Tooltip>
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
