/**
 * 定时任务共享列表：settings（SettingsRow）与 chat（schedList li）双变体。
 * 行操作（启停/立即执行/删除/编辑）由 useWorkflowsState 提供回调。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import { scheduleLabel, workflowEnabledLabel, type WorkflowDefinition } from '../../api/workflowApi';
import { SettingsRow } from './SettingsUI';
import { Tooltip } from '../ui';
import styles from './ScheduledTasksPanel.module.css';
import settingsStyles from './SettingsScheduleTab.module.css';

export type WorkflowListProps = {
  variant: 'settings' | 'chat';
  workflows: WorkflowDefinition[];
  busy: boolean;
  /** chat 面加载中（空态用非紧凑样式） */
  loading?: boolean;
  /** 空态文案（resolveWorkflowJobsEmptyCopy 结果；null = 渲染列表） */
  emptyCopy: { title: string; hint?: string } | null;
  onToggle: (w: WorkflowDefinition) => void;
  onTrigger: (w: WorkflowDefinition) => void;
  onDelete: (w: WorkflowDefinition) => void;
  /** settings 面编辑入口 */
  onEdit?: (w: WorkflowDefinition) => void;
  /** chat 面列表 aria-labelledby */
  listTitleId?: string;
};

export const WorkflowList: React.FC<WorkflowListProps> = ({
  variant,
  workflows,
  busy,
  loading = false,
  emptyCopy,
  onToggle,
  onTrigger,
  onDelete,
  onEdit,
  listTitleId,
}) => {
  const settingsVariant = variant === 'settings';

  if (settingsVariant) {
    return (
      <div>
        {emptyCopy ? (
          <SettingsRow
            title={
              <span className="sched-settings-empty" role="status" aria-live="polite">
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
              return (
                <SettingsRow
                  key={w.id}
                  title={
                    <Tooltip content={w.prompt || w.name}>
                      <span className="sched-settings-row-name">{w.name}</span>
                    </Tooltip>
                  }
                  desc={
                    <Tooltip content={`${schedText}${enabled ? '' : ` · ${statusLabel}`}`}>
                      <span className="sched-settings-row-schedule">
                        {schedText}
                        {!enabled ? ` · ${statusLabel}` : ''}
                      </span>
                    </Tooltip>
                  }
                  control={
                    <div className={settingsStyles.controlGroup}>
                      <Tooltip content={enabled ? '暂停' : '启用'}>
                        <input
                          type="checkbox"
                          className="settings-switch"
                          checked={enabled}
                          disabled={busy}
                          aria-label={enabled ? `暂停 ${w.name}` : `启用 ${w.name}`}
                          onChange={() => onToggle(w)}
                        />
                      </Tooltip>
                      <Tooltip content="编辑">
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          aria-label={`编辑 ${w.name}`}
                          disabled={busy}
                          onClick={() => onEdit?.(w)}
                        >
                          <Lucide.Pencil size={16} aria-hidden />
                        </button>
                      </Tooltip>
                      <Tooltip content="立即执行">
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          aria-label={`立即执行 ${w.name}`}
                          disabled={busy}
                          onClick={() => onTrigger(w)}
                        >
                          <Lucide.Zap size={16} aria-hidden />
                        </button>
                      </Tooltip>
                      <Tooltip content="删除">
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          aria-label={`删除 ${w.name}`}
                          disabled={busy}
                          onClick={() => onDelete(w)}
                        >
                          <Lucide.Trash2 size={16} aria-hidden />
                        </button>
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
            return (
              <li key={w.id} className={`${styles.schedItem} ${styles.schedItemDense}`}>
                <div className={styles.schedItemMain}>
                  <Tooltip content={w.prompt || w.name}>
                    <div className={styles.schedItemName}>
                      {w.name}
                    </div>
                  </Tooltip>
                  <div className={styles.schedItemMeta}>
                    {scheduleLabel(w.schedule)}
                    {paused ? ` · ${workflowEnabledLabel(false)}` : ''}
                  </div>
                </div>
                <div className={styles.schedItemActions} role="group" aria-label={`${w.name} 操作`}>
                  <Tooltip content="立即触发">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      aria-label={`立即触发 ${w.name}`}
                      disabled={busy}
                      onClick={() => onTrigger(w)}
                    >
                      <Lucide.Play size={16} aria-hidden />
                    </button>
                  </Tooltip>
                  <Tooltip content={paused ? '启用' : '暂停'}>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      aria-label={toggleLabel}
                      aria-pressed={!paused}
                      disabled={busy}
                      onClick={() => onToggle(w)}
                    >
                      {paused ? (
                        <Lucide.PlayCircle size={16} aria-hidden />
                      ) : (
                        <Lucide.Pause size={16} aria-hidden />
                      )}
                    </button>
                  </Tooltip>
                  <Tooltip content="删除">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      aria-label={`删除 ${w.name}`}
                      disabled={busy}
                      onClick={() => onDelete(w)}
                    >
                      <Lucide.Trash2 size={16} aria-hidden />
                    </button>
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
