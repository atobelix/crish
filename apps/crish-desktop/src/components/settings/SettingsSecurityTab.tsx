/**
 * 设置 · 安全：权限模式、工作区与信任命令（批准记忆）。
 *
 * P1 权限归一（B2/B3，主控裁决 3）：白名单 = 批准记忆（记住用户批准过的
 * 命令），**不再参与任何自动放行判定**；风险展示收敛为纯 UX 提示——不再
 * 读取前端风险正则表、不再做 allow/deny 判定（放行权威 = 引擎
 * call_verdict / ApprovalGateImpl 单一裁决链）。
 */
import React, { useId, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useToast } from '../../services/toast/ToastContext';
import styles from './SettingsSecurityTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { Button, Select, Tooltip } from '../ui';
import {
  usePermissionField,
  selectPermissionMode,
  selectCommandPermissions,
} from '../../store/storeAccess';
import { getWorkspacePath, listProjects } from '../../api/projectStore';
import {
  PERMISSION_MODES,
  coercePermissionMode,
  transitionPermissionMode,
  type PermissionMode,
} from '../../api/permissionModes';
import { sanitizeWhitelistEntry } from '../../api/commandPermissions';

/** 常用只读命令 */
const QUICK_WHITELIST_CMDS = [
  'git status',
  'git diff',
  'git log',
  'npm test',
  'npm run typecheck',
] as const;

const WHITELIST_MATCH_HINT = '按整条命令匹配；后面可带参数，不会误伤相似命令名';

/**
 * 纯 UX 提示（P1 权限归一 B2，主控裁决 3）：白名单仅为批准记忆——是否放行
 * 由引擎按权限模式裁决；高危命令（rm / format 等）即使加入白名单也不会被
 * 自动放行（引擎红线/审批门禁兜底），本处不做任何 allow/deny 判定、不读
 * 风险正则表。
 */
const WHITELIST_REMEMBER_HINT =
  '高危命令（如 rm、format）不会被自动放行——白名单仅为批准记忆，放行由引擎按权限模式裁决';

/** 路径短名 */
function pathLeaf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export const SettingsSecurityTab: React.FC = () => {
  const { showToast: _showToast } = useToast();
  const permissionModeRaw = usePermissionField(selectPermissionMode);
  const setPermissionMode = usePermissionField((s) => s.setPermissionMode);
  const commandPermissions = usePermissionField(selectCommandPermissions);
  const addCommandPermissionStore = usePermissionField(
    (s) => s.addCommandPermission
  );
  const removeCommandPermissionStore = usePermissionField(
    (s) => s.removeCommandPermission
  );
  const setCommandPermissions = usePermissionField(
    (s) => s.setCommandPermissions
  );
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
    const raw: string[] = commandPermissions || [];
    const cleaned = raw.map((x) => sanitizeWhitelistEntry(x)).filter(Boolean);
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

  const draftTrimmed = newWhitelistCmd.trim();

  const addWhitelist = (raw?: string) => {
    const source = raw ?? newWhitelistCmd;
    try {
      const cmd = sanitizeWhitelistEntry(source);
      if (!cmd) {
        if (source.trim()) showToast('无效命令', undefined, { type: 'error' });
        return;
      }
      const exists = whitelist.some(
        (x) => sanitizeWhitelistEntry(x).toLowerCase() === cmd.toLowerCase()
      );
      if (exists) return;
      addCommandPermissionStore(cmd);
      if (!raw) setNewWhitelistCmd('');
    } catch (err) {
      showToast('添加失败：' + String(err), undefined, { type: 'error' });
    }
  };

  const removeWhitelist = (cmd: string) => {
    try {
      removeCommandPermissionStore(cmd);
    } catch (err) {
      showToast('移除失败：' + String(err), undefined, { type: 'error' });
    }
  };

  const doClearWhitelist = () => {
    try {
      setCommandPermissions([]);
      setShowClearConfirm(false);
    } catch (err) {
      showToast('清空失败：' + String(err), undefined, { type: 'error' });
    }
  };

  const onPermissionChange = (v: string) => {
    try {
      const next = transitionPermissionMode(permissionMode, v);
      if (next === permissionMode) return;
      setPermissionMode(next as PermissionMode);
    } catch (err) {
      showToast('权限切换失败：' + String(err), undefined, { type: 'error' });
    }
  };

  const _inputRiskTitle = draftTrimmed
    ? `${WHITELIST_REMEMBER_HINT} · 回车添加`
    : `${WHITELIST_MATCH_HINT} · 回车添加`;

  return (
    <SettingsPage title="安全">
      <SettingsSection title="权限">
        <SettingsCard>
          <SettingsRow
            title={<span id={`${permLabelId}-row`}>权限模式</span>}
            desc="工具执行前要不要先确认"
            control={
              <Select
                className="settings-security-select"
                value={permissionMode}
                options={PERMISSION_MODES.map((m) => ({
                  id: m.id,
                  label: m.label,
                  hint: m.description,
                }))}
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
                    title={
                      <Tooltip content={path}>
                        <span className="settings-path-ellipsis">{leaf}</span>
                      </Tooltip>
                    }
                    desc={
                      <span className="settings-security-path">{path}</span>
                    }
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
              <label htmlFor={wlInputId} className={styles.labelTitle}>
                添加命令
              </label>
              <span className={styles.labelDesc}>
                加入批准记忆（放行仍由引擎裁决）
              </span>
            </div>
            <div className={styles.inputGroup}>
              <input
                id={wlInputId}
                type="text"
                placeholder="如 git status"
                value={newWhitelistCmd}
                onChange={(e) => setNewWhitelistCmd(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                aria-label="要信任的命令"
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
              <Tooltip
                content={draftTrimmed ? '加入白名单（批准记忆）' : '请输入命令'}
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.actionBtn}
                  aria-label="添加命令"
                  disabled={!draftTrimmed}
                  onClick={() => addWhitelist()}
                >
                  添加
                </Button>
              </Tooltip>
              {whitelist.length > 0 && !showClearConfirm ? (
                <Tooltip content={`清空全部 ${whitelist.length} 条（需确认）`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.actionBtn}
                    aria-label={`清空全部 ${whitelist.length} 条白名单`}
                    onClick={() => setShowClearConfirm(true)}
                  >
                    清空
                  </Button>
                </Tooltip>
              ) : null}
              {showClearConfirm ? (
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      fontSize: '0.8125rem',
                      color: 'var(--color-text-secondary)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    确定清除所有白名单命令？此操作不可撤销
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className={styles.actionBtn}
                    onClick={doClearWhitelist}
                  >
                    确认
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.actionBtn}
                    onClick={() => setShowClearConfirm(false)}
                  >
                    取消
                  </Button>
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
                  (x) =>
                    sanitizeWhitelistEntry(x).toLowerCase() ===
                    cmd.toLowerCase()
                );
                return (
                  <Tooltip
                    key={cmd}
                    content={already ? '已添加' : `添加 ${cmd}`}
                  >
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
              title={
                <span className="settings-list-empty">还没有信任的命令</span>
              }
              desc="上方输入命令并添加，或点击常用预设"
            />
          ) : (
            whitelist.map((cmd) => {
              return (
                <SettingsRow
                  key={cmd}
                  title={<span className={styles.cmdSpan}>{cmd}</span>}
                  desc="批准记忆：匹配后仍需引擎按当前权限模式裁决"
                  control={
                    <Tooltip content={`移除 ${cmd}`}>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => removeWhitelist(cmd)}
                        aria-label={`移除 ${cmd}`}
                        icon={<Lucide.Trash2 size={14} aria-hidden />}
                      />
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
