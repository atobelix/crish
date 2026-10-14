/**
 * 设置 · 安全：权限模式、工作区与信任命令（批准记忆）。
 *
 * P1 权限归一（B2/B3，主控裁决 3）：白名单 = 批准记忆（记住用户批准过的
 * 命令），**不再参与任何自动放行判定**；风险展示收敛为纯 UX 提示——不再
 * 读取前端风险正则表、不再做 allow/deny 判定（放行权威 = 引擎
 * call_verdict / ApprovalGateImpl 单一裁决链）。
 */
import React, { useId, useMemo, useState } from 'react';

import { useToast } from '../../services/toast/ToastContext';
import styles from './SettingsSecurityTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { Button, Input, Select, Tooltip } from '../ui';
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
import {
  QUICK_WHITELIST_CMDS,
  dedupeWhitelist,
  pathLeaf,
} from './settingsSecurityModel';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

const PERM_ICON_MAP: Record<string, React.ReactNode> = {
  ask: <AppIcon name="shield-check" size={14} />,
  deep: <AppIcon name="search" size={14} />,
  plan: <AppIcon name="target" size={14} />,
  full: <AppIcon name="zap" size={14} />,
};

export const SettingsSecurityTab: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
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

  const whitelist = useMemo(
    () => dedupeWhitelist(commandPermissions || []),
    [commandPermissions]
  );

  const draftTrimmed = newWhitelistCmd.trim();

  const addWhitelist = (raw?: string) => {
    const source = raw ?? newWhitelistCmd;
    try {
      const cmd = sanitizeWhitelistEntry(source);
      if (!cmd) {
        if (source.trim()) {
          showToast(
            t('settings.security.invalidCommand', '无效命令'),
            undefined,
            { type: 'error' }
          );
        }
        return;
      }
      const exists = whitelist.some(
        (x) => sanitizeWhitelistEntry(x).toLowerCase() === cmd.toLowerCase()
      );
      if (exists) return;
      addCommandPermissionStore(cmd);
      if (!raw) setNewWhitelistCmd('');
    } catch (err) {
      showToast(
        t('settings.security.addFailed', '添加失败：{error}', {
          error: String(err),
        }),
        undefined,
        { type: 'error' }
      );
    }
  };

  const removeWhitelist = (cmd: string) => {
    try {
      removeCommandPermissionStore(cmd);
    } catch (err) {
      showToast(
        t('settings.security.removeFailed', '移除失败：{error}', {
          error: String(err),
        }),
        undefined,
        { type: 'error' }
      );
    }
  };

  const doClearWhitelist = () => {
    try {
      setCommandPermissions([]);
      setShowClearConfirm(false);
    } catch (err) {
      showToast(
        t('settings.security.clearFailed', '清空失败：{error}', {
          error: String(err),
        }),
        undefined,
        { type: 'error' }
      );
    }
  };

  const onPermissionChange = (v: string) => {
    try {
      const next = transitionPermissionMode(permissionMode, v);
      if (next === permissionMode) return;
      setPermissionMode(next as PermissionMode);
    } catch (err) {
      showToast(
        t('settings.security.permChangeFailed', '权限切换失败：{error}', {
          error: String(err),
        }),
        undefined,
        { type: 'error' }
      );
    }
  };

  return (
    <SettingsPage title={t('nav.security', '安全')}>
      <SettingsSection title={t('settings.security.permissionSection', '权限')}>
        <SettingsCard>
          <SettingsRow
            title={
              <span id={`${permLabelId}-row`}>
                {t('settings.security.permissionMode', '权限模式')}
              </span>
            }
            desc={t(
              'settings.security.permissionModeDesc',
              '工具执行前要不要先确认'
            )}
            control={
              <Select
                id={permLabelId}
                size="sm"
                className="settings-security-select"
                value={permissionMode}
                options={PERMISSION_MODES.map((m) => ({
                  id: m.id,
                  label: t(`chat.permission.${m.id}.label`, m.label),
                  hint: t(`chat.permission.${m.id}.description`, m.description),
                  icon: PERM_ICON_MAP[m.id],
                }))}
                onChange={onPermissionChange}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('nav.workspace', '工作区')}>
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
                <div className={styles.morePathsWrapper}>
                  <Button
                    bare
                    type="button"
                    className="settings-chip-btn"
                    onClick={() => setShowAllPaths(true)}
                  >
                    {t('settings.security.morePaths', '+{count} 更多', {
                      count: extraCount,
                    })}
                  </Button>
                </div>
              ) : null}
              {showAllPaths && extraCount > 0 ? (
                <div className={styles.morePathsWrapper}>
                  <Button
                    bare
                    type="button"
                    className="settings-chip-btn"
                    onClick={() => setShowAllPaths(false)}
                  >
                    {t('common.collapse', '收起')}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <SettingsRow
              title={
                <span className="settings-list-empty">
                  {t('settings.security.noOpenProjects', '未打开项目')}
                </span>
              }
              desc={t(
                'settings.security.noOpenProjectsDesc',
                '打开项目后会显示在这里'
              )}
            />
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.security.trustedCommandsSection', '信任命令')}
      >
        <SettingsCard>
          <div className={styles.wlRow}>
            <div className={styles.labelCol}>
              <label htmlFor={wlInputId} className={styles.labelTitle}>
                {t('settings.security.addCommandTitle', '添加命令')}
              </label>
              <span className={styles.labelDesc}>
                {t(
                  'settings.security.addCommandDesc',
                  '加入批准记忆（放行仍由引擎裁决）'
                )}
              </span>
            </div>
            <div className={styles.inputGroup}>
              <Input
                id={wlInputId}
                size="sm"
                placeholder={t(
                  'settings.security.cmdInputPlaceholder',
                  '如 git status'
                )}
                value={newWhitelistCmd}
                onChange={(e) => setNewWhitelistCmd(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                aria-label={t('settings.security.cmdInputAria', '要信任的命令')}
                className={styles.inputGrow}
                onEnter={addWhitelist}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && newWhitelistCmd) {
                    e.preventDefault();
                    setNewWhitelistCmd('');
                  }
                }}
              />
              <Tooltip
                content={
                  draftTrimmed
                    ? t(
                        'settings.security.addToWhitelistTooltip',
                        '加入白名单（批准记忆）'
                      )
                    : t('settings.security.enterCmdTooltip', '请输入命令')
                }
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.actionBtn}
                  aria-label={t('settings.security.addCommandAria', '添加命令')}
                  disabled={!draftTrimmed}
                  onClick={() => addWhitelist()}
                >
                  {t('common.add', '添加')}
                </Button>
              </Tooltip>
              {whitelist.length > 0 && !showClearConfirm ? (
                <Tooltip
                  content={t(
                    'settings.security.clearAllTooltip',
                    '清空全部 {count} 条（需确认）',
                    { count: whitelist.length }
                  )}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.actionBtn}
                    aria-label={t(
                      'settings.security.clearAllAria',
                      '清空全部 {count} 条白名单',
                      { count: whitelist.length }
                    )}
                    onClick={() => setShowClearConfirm(true)}
                  >
                    {t('common.clear', '清空')}
                  </Button>
                </Tooltip>
              ) : null}
              {showClearConfirm ? (
                <div className={styles.confirmClearGroup}>
                  <span className={styles.confirmClearPrompt}>
                    {t(
                      'settings.security.confirmClearPrompt',
                      '确定清除所有白名单命令？此操作不可撤销'
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className={styles.actionBtn}
                    onClick={doClearWhitelist}
                  >
                    {t('common.confirm', '确认')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.actionBtn}
                    onClick={() => setShowClearConfirm(false)}
                  >
                    {t('common.cancel', '取消')}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          <div className={styles.wlRowNoBorder}>
            <div className={styles.labelCol}>
              <span className={styles.labelTitle}>
                {t('settings.security.presetsTitle', '常用预设')}
              </span>
              <span className={styles.labelDesc}>
                {t('settings.security.presetsDesc', '点击一键加入信任')}
              </span>
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
                    content={
                      already
                        ? t('settings.security.cmdAlreadyAdded', '已添加')
                        : t('settings.security.addCmdPrompt', '添加 {cmd}', {
                            cmd,
                          })
                    }
                  >
                    <Button
                      bare
                      type="button"
                      className={styles.presetChip}
                      disabled={already}
                      aria-pressed={already}
                      aria-label={
                        already
                          ? t(
                              'settings.security.cmdAlreadyAddedAria',
                              '{cmd} 已添加',
                              { cmd }
                            )
                          : t('settings.security.addCmdAria', '添加 {cmd}', {
                              cmd,
                            })
                      }
                      onClick={() => addWhitelist(cmd)}
                    >
                      {cmd}
                    </Button>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t(
          'settings.security.trustedCommandsCount',
          '已信任命令 ({count})',
          { count: whitelist.length }
        )}
      >
        <SettingsCard>
          {whitelist.length === 0 ? (
            <SettingsRow
              title={
                <span className="settings-list-empty">
                  {t('settings.security.noTrustedCommands', '还没有信任的命令')}
                </span>
              }
              desc={t(
                'settings.security.noTrustedCommandsDesc',
                '上方输入命令并添加，或点击常用预设'
              )}
            />
          ) : (
            whitelist.map((cmd) => {
              return (
                <SettingsRow
                  key={cmd}
                  title={<span className={styles.cmdSpan}>{cmd}</span>}
                  desc={t(
                    'settings.security.trustedCmdNote',
                    '批准记忆：匹配后仍需引擎按当前权限模式裁决'
                  )}
                  control={
                    <Tooltip
                      content={t(
                        'settings.security.removeCmdTooltip',
                        '移除 {cmd}',
                        { cmd }
                      )}
                    >
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => removeWhitelist(cmd)}
                        aria-label={t(
                          'settings.security.removeCmdAria',
                          '移除 {cmd}',
                          { cmd }
                        )}
                        icon={<AppIcon name="trash" size={14} aria-hidden />}
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
