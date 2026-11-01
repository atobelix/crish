/**
 * 定时任务共享列表：settings（SettingsRow）与 chat（schedList li）双变体。
 * 行操作（启停/立即执行/删除/编辑）由 useWorkflowsState 提供回调。
 */
import React, { useState } from 'react';

import {
  scheduleLabel,
  workflowEnabledLabel,
  type WorkflowDefinition,
} from '../../api/workflowApi';
import { SettingsRow } from './SettingsUI';
import { Button, ConfirmDialog, Switch, Tooltip } from '@/components/ui';
import { useI18n } from '../../i18n';
import styles from './ScheduledTasksPanel.module.css';
import settingsStyles from './SettingsScheduleTab.module.css';
import { AppIcon } from '@/components/ui/icons';

export type WorkflowListProps = {
  variant: 'settings' | 'chat';
  workflows: WorkflowDefinition[];
  busy: boolean;
  /** 单行启停物理锁集合（消除点一行冻全表） */
  togglingIds?: ReadonlySet<string>;
  /** 单行立即运行物理锁集合 */
  triggeringIds?: ReadonlySet<string>;
  /** chat 面加载中（空态用非紧凑样式） */
  loading?: boolean;
  /** 空态文案（resolveWorkflowJobsEmptyCopy 结果；null = 渲染列表） */
  emptyCopy: { title: string; hint?: string } | null;
  onToggle: (w: WorkflowDefinition) => void;
  onTrigger: (w: WorkflowDefinition) => void;
  onDelete: (w: WorkflowDefinition) => void;
  /** 编辑入口 */
  onEdit?: (w: WorkflowDefinition) => void;
  /** 点击绑定会话徽标跳转至目标会话 */
  onOpenSession?: (sessionId: string, workflow: WorkflowDefinition) => void;
  /** chat 面列表 aria-labelledby */
  listTitleId?: string;
};

export const WorkflowList: React.FC<WorkflowListProps> = ({
  variant,
  workflows,
  busy,
  togglingIds,
  triggeringIds,
  loading = false,
  emptyCopy,
  onToggle,
  onTrigger,
  onDelete,
  onEdit,
  onOpenSession,
  listTitleId,
}) => {
  const { t } = useI18n();
  const [pendingDelete, setPendingDelete] = useState<WorkflowDefinition | null>(
    null
  );
  const settingsVariant = variant === 'settings';

  const deleteConfirm = (
    <ConfirmDialog
      open={pendingDelete !== null}
      danger
      title={t('settings.schedule.deleteConfirmTitle', '删除定时任务')}
      description={
        pendingDelete
          ? t(
              'settings.schedule.deleteConfirmDesc',
              '确定要删除「{name}」吗？删除后将停止后续计划执行，此操作不可撤销。',
              { name: pendingDelete.name }
            )
          : undefined
      }
      confirmLabel={t('settings.schedule.deleteConfirmAction', '确认删除')}
      cancelLabel={t('common.cancel', '取消')}
      onCancel={() => setPendingDelete(null)}
      onConfirm={() => {
        if (pendingDelete) onDelete(pendingDelete);
        setPendingDelete(null);
      }}
    />
  );

  if (settingsVariant) {
    return (
      <div>
        {deleteConfirm}
        {emptyCopy ? (
          <SettingsRow
            title={
              <span
                className="sched-settings-empty"
                role="status"
                aria-live="polite"
              >
                {emptyCopy.title}
              </span>
            }
            desc={emptyCopy.hint}
          />
        ) : (
          <div
            className="sched-settings-list"
            role="list"
            aria-labelledby="sched-settings-title"
          >
            {workflows.map((w) => {
              const enabled = w.enabled !== false;
              const statusLabel = workflowEnabledLabel(enabled);
              const schedText = scheduleLabel(w.schedule);
              const isToggling = togglingIds ? togglingIds.has(w.id) : busy;
              const isTriggering = triggeringIds
                ? triggeringIds.has(w.id)
                : busy;
              const isRowBusy =
                togglingIds !== undefined || triggeringIds !== undefined
                  ? isToggling || isTriggering
                  : busy;
              const targetSessionId =
                typeof w.targetSessionId === 'string' &&
                w.targetSessionId.trim()
                  ? w.targetSessionId.trim()
                  : undefined;
              const cwdText =
                typeof w.cwd === 'string' && w.cwd.trim() ? w.cwd.trim() : '';
              const projectLabel = cwdText
                ? t('settings.schedule.projectLabel', '项目: {name}', {
                    name:
                      cwdText.split(/[\\/]/).filter(Boolean).pop() || cwdText,
                  })
                : t('settings.schedule.globalWorkspace', '全局工作区');

              return (
                <SettingsRow
                  key={w.id}
                  title={
                    <Tooltip content={w.prompt || w.name}>
                      <span className="sched-settings-row-name">{w.name}</span>
                    </Tooltip>
                  }
                  desc={
                    <div className={settingsStyles.metaRow}>
                      <Tooltip
                        content={`${schedText}${enabled ? '' : ` · ${statusLabel}`} · ${projectLabel}`}
                      >
                        <span className="sched-settings-row-schedule">
                          {schedText}
                          {!enabled ? ` · ${statusLabel}` : ''}
                          {` · ${projectLabel}`}
                        </span>
                      </Tooltip>
                      {targetSessionId ? (
                        <Tooltip
                          content={t(
                            'settings.schedule.boundSessionTooltip',
                            '点击跳转至绑定会话: {id}',
                            { id: targetSessionId }
                          )}
                        >
                          {onOpenSession ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className={settingsStyles.sessionBadge}
                              aria-label={t(
                                'settings.schedule.boundSessionAria',
                                '跳转至绑定会话 {id}',
                                { id: targetSessionId }
                              )}
                              onClick={() => onOpenSession(targetSessionId, w)}
                            >
                              {t('settings.schedule.boundSession', '绑定会话')}
                            </Button>
                          ) : (
                            <span className={settingsStyles.sessionBadge}>
                              {t('settings.schedule.boundSession', '绑定会话')}
                            </span>
                          )}
                        </Tooltip>
                      ) : null}
                    </div>
                  }
                  control={
                    <div className={settingsStyles.controlGroup}>
                      <Tooltip
                        content={
                          enabled
                            ? t('settings.schedule.pause', '暂停')
                            : t('settings.schedule.enable', '启用')
                        }
                      >
                        <Switch
                          checked={enabled}
                          disabled={isToggling}
                          aria-label={
                            enabled
                              ? t(
                                  'settings.schedule.pauseTaskAria',
                                  '暂停 {name}',
                                  { name: w.name }
                                )
                              : t(
                                  'settings.schedule.enableTaskAria',
                                  '启用 {name}',
                                  { name: w.name }
                                )
                          }
                          onCheckedChange={() => onToggle(w)}
                        />
                      </Tooltip>
                      <Tooltip content={t('settings.schedule.edit', '编辑')}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t(
                            'settings.schedule.editTaskAria',
                            '编辑 {name}',
                            { name: w.name }
                          )}
                          disabled={isRowBusy}
                          onClick={() => onEdit?.(w)}
                          icon={<AppIcon name="pencil" size={16} aria-hidden />}
                        />
                      </Tooltip>
                      <Tooltip
                        content={t('settings.schedule.runNow', '立即运行')}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t(
                            'settings.schedule.runNowAriaExecute',
                            '立即运行 · 立即执行 {name}',
                            { name: w.name }
                          )}
                          disabled={isTriggering}
                          onClick={() => onTrigger(w)}
                          icon={<AppIcon name="zap" size={16} aria-hidden />}
                        />
                      </Tooltip>
                      <Tooltip content={t('settings.schedule.delete', '删除')}>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          aria-label={t(
                            'settings.schedule.deleteTaskAria',
                            '删除 {name}',
                            { name: w.name }
                          )}
                          disabled={isRowBusy}
                          onClick={() => setPendingDelete(w)}
                          icon={<AppIcon name="trash" size={16} aria-hidden />}
                        />
                      </Tooltip>
                    </div>
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {deleteConfirm}
      {emptyCopy ? (
        <div
          className={`${styles.schedEmpty}${loading ? '' : ` ${styles.schedEmptyDense}`}`}
          role="status"
          aria-live="polite"
        >
          <span>{emptyCopy.title}</span>
          {emptyCopy.hint ? (
            <span className={styles.schedEmptySub}>{emptyCopy.hint}</span>
          ) : null}
        </div>
      ) : (
        <ul className={styles.schedList} aria-labelledby={listTitleId}>
          {workflows.map((w) => {
            const paused = w.enabled === false;
            const toggleLabel = paused
              ? t('settings.schedule.enableTaskAria', '启用 {name}', {
                  name: w.name,
                })
              : t('settings.schedule.pauseTaskAria', '暂停 {name}', {
                  name: w.name,
                });
            const isToggling = togglingIds ? togglingIds.has(w.id) : busy;
            const isTriggering = triggeringIds ? triggeringIds.has(w.id) : busy;
            const isRowBusy =
              togglingIds !== undefined || triggeringIds !== undefined
                ? isToggling || isTriggering
                : busy;
            const targetSessionId =
              typeof w.targetSessionId === 'string' && w.targetSessionId.trim()
                ? w.targetSessionId.trim()
                : undefined;
            const cwdText =
              typeof w.cwd === 'string' && w.cwd.trim() ? w.cwd.trim() : '';
            const projectLabel = cwdText
              ? t('settings.schedule.projectLabel', '项目: {name}', {
                  name: cwdText.split(/[\\/]/).filter(Boolean).pop() || cwdText,
                })
              : t('settings.schedule.globalWorkspace', '全局工作区');

            return (
              <li
                key={w.id}
                className={`${styles.schedItem} ${styles.schedItemDense}`}
              >
                <div className={styles.schedItemMain}>
                  <Tooltip content={w.prompt || w.name}>
                    <div className={styles.schedItemName}>{w.name}</div>
                  </Tooltip>
                  <div className={styles.schedItemMeta}>
                    <span>
                      {scheduleLabel(w.schedule)}
                      {paused ? ` · ${workflowEnabledLabel(false)}` : ''}
                      {` · ${projectLabel}`}
                    </span>
                    {targetSessionId ? (
                      <Tooltip
                        content={t(
                          'settings.schedule.boundSessionTooltip',
                          '点击跳转至绑定会话: {id}',
                          { id: targetSessionId }
                        )}
                      >
                        {onOpenSession ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className={styles.sessionBadge}
                            aria-label={t(
                              'settings.schedule.boundSessionAria',
                              '跳转至绑定会话 {id}',
                              { id: targetSessionId }
                            )}
                            onClick={() => onOpenSession(targetSessionId, w)}
                          >
                            {t('settings.schedule.boundSession', '绑定会话')}
                          </Button>
                        ) : (
                          <span className={styles.sessionBadge}>
                            {t('settings.schedule.boundSession', '绑定会话')}
                          </span>
                        )}
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
                <div
                  className={styles.schedItemActions}
                  role="group"
                  aria-label={t(
                    'settings.schedule.taskActionsAria',
                    '{name} 操作',
                    { name: w.name }
                  )}
                >
                  <Tooltip content={t('settings.schedule.runNow', '立即运行')}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t(
                        'settings.schedule.runNowAriaTrigger',
                        '立即运行 · 立即触发 {name}',
                        { name: w.name }
                      )}
                      disabled={isTriggering}
                      onClick={() => onTrigger(w)}
                      icon={<AppIcon name="play" size={16} aria-hidden />}
                    />
                  </Tooltip>
                  <Tooltip
                    content={
                      paused
                        ? t('settings.schedule.enable', '启用')
                        : t('settings.schedule.pause', '暂停')
                    }
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={toggleLabel}
                      aria-pressed={!paused}
                      disabled={isToggling}
                      onClick={() => onToggle(w)}
                      icon={
                        paused ? (
                          <AppIcon name="play-circle" size={16} aria-hidden />
                        ) : (
                          <AppIcon name="pause" size={16} aria-hidden />
                        )
                      }
                    />
                  </Tooltip>
                  <Tooltip content={t('settings.schedule.edit', '编辑')}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t(
                        'settings.schedule.editTaskAria',
                        '编辑 {name}',
                        { name: w.name }
                      )}
                      disabled={isRowBusy}
                      onClick={() => onEdit?.(w)}
                      icon={<AppIcon name="pencil" size={16} aria-hidden />}
                    />
                  </Tooltip>
                  <Tooltip content={t('settings.schedule.delete', '删除')}>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      aria-label={t(
                        'settings.schedule.deleteTaskAria',
                        '删除 {name}',
                        { name: w.name }
                      )}
                      disabled={isRowBusy}
                      onClick={() => setPendingDelete(w)}
                      icon={<AppIcon name="trash" size={16} aria-hidden />}
                    />
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
