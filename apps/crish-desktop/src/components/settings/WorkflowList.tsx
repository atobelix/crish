/**
 * 定时任务共享列表：settings（SettingsRow）与 chat（schedList li）双变体。
 * 行操作（启停/立即执行/删除/编辑）由 useWorkflowsState 提供回调。
 */
import React from 'react';

import {
  scheduleLabel,
  workflowEnabledLabel,
  type WorkflowDefinition,
} from '../../api/workflowApi';
import { SettingsRow } from './SettingsUI';
import { Button, Switch, Tooltip } from '@/components/ui';
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
  const settingsVariant = variant === 'settings';

  if (settingsVariant) {
    return (
      <div>
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
                ? `项目: ${cwdText.split(/[\\/]/).filter(Boolean).pop() || cwdText}`
                : '全局工作区';

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
                          content={`点击跳转至绑定会话: ${targetSessionId}`}
                        >
                          {onOpenSession ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className={settingsStyles.sessionBadge}
                              aria-label={`跳转至绑定会话 ${targetSessionId}`}
                              onClick={() => onOpenSession(targetSessionId, w)}
                            >
                              绑定会话
                            </Button>
                          ) : (
                            <span className={settingsStyles.sessionBadge}>
                              绑定会话
                            </span>
                          )}
                        </Tooltip>
                      ) : null}
                    </div>
                  }
                  control={
                    <div className={settingsStyles.controlGroup}>
                      <Tooltip content={enabled ? '暂停' : '启用'}>
                        <Switch
                          checked={enabled}
                          disabled={isToggling}
                          aria-label={
                            enabled ? `暂停 ${w.name}` : `启用 ${w.name}`
                          }
                          onCheckedChange={() => onToggle(w)}
                        />
                      </Tooltip>
                      <Tooltip content="编辑">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`编辑 ${w.name}`}
                          disabled={isRowBusy}
                          onClick={() => onEdit?.(w)}
                          icon={<AppIcon name="pencil" size={16} aria-hidden />}
                        />
                      </Tooltip>
                      <Tooltip content="立即运行">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`立即运行 · 立即执行 ${w.name}`}
                          disabled={isTriggering}
                          onClick={() => onTrigger(w)}
                          icon={<AppIcon name="zap" size={16} aria-hidden />}
                        />
                      </Tooltip>
                      <Tooltip content="删除">
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          aria-label={`删除 ${w.name}`}
                          disabled={isRowBusy}
                          onClick={() => onDelete(w)}
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
            const toggleLabel = paused ? `启用 ${w.name}` : `暂停 ${w.name}`;
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
              ? `项目: ${cwdText.split(/[\\/]/).filter(Boolean).pop() || cwdText}`
              : '全局工作区';

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
                        content={`点击跳转至绑定会话: ${targetSessionId}`}
                      >
                        {onOpenSession ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className={styles.sessionBadge}
                            aria-label={`跳转至绑定会话 ${targetSessionId}`}
                            onClick={() => onOpenSession(targetSessionId, w)}
                          >
                            绑定会话
                          </Button>
                        ) : (
                          <span className={styles.sessionBadge}>绑定会话</span>
                        )}
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
                <div
                  className={styles.schedItemActions}
                  role="group"
                  aria-label={`${w.name} 操作`}
                >
                  <Tooltip content="立即运行">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`立即运行 · 立即触发 ${w.name}`}
                      disabled={isTriggering}
                      onClick={() => onTrigger(w)}
                      icon={<AppIcon name="play" size={16} aria-hidden />}
                    />
                  </Tooltip>
                  <Tooltip content={paused ? '启用' : '暂停'}>
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
                  <Tooltip content="编辑">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`编辑 ${w.name}`}
                      disabled={isRowBusy}
                      onClick={() => onEdit?.(w)}
                      icon={<AppIcon name="pencil" size={16} aria-hidden />}
                    />
                  </Tooltip>
                  <Tooltip content="删除">
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      aria-label={`删除 ${w.name}`}
                      disabled={isRowBusy}
                      onClick={() => onDelete(w)}
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
