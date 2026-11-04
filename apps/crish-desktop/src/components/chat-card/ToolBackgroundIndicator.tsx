/**
 * 会话级工具后台指示（BG5）：ChatCard 头部浮层「后台中 N」。
 *
 * 数据源 = 引擎工具后台注册表快照（core_list_tool_background_tasks，
 * 2s 轮询 + 打开面板 / 取消后立即刷新）；BG3 的 settled 回注负责卡面
 * 结果回填，本指示只表达「本会话还有几个工具在后台」。
 * 与 shell 进程任务面（useBackgroundTaskPolling / 后台任务面板）分开
 * 呈现、不合并（两类任务性质不同，方案定案）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './ToolBackgroundIndicator.module.css';
import { Button } from '@/components/ui';
import { useI18n } from '../../i18n';
import type { TranslateFunction } from '../../i18n/types';
import {
  cancelToolBackgroundTask,
  listToolBackgroundTasks,
  type ToolBackgroundTaskInfo,
} from '../../api/toolBackgroundApi';
import { formatDurationLabel } from '../../api/tool-presentation/processMetricsEngine';

const POLL_MS = 2000;

function taskElapsedLabel(
  t: TranslateFunction,
  task: ToolBackgroundTaskInfo,
  now: number
): string {
  if (task.state === 'queued' || task.startedAtMs === null)
    return t('tool.background.queued');
  return t('tool.background.runningFor', {
    duration: formatDurationLabel(Math.max(0, now - task.startedAtMs)),
  });
}

export const ToolBackgroundIndicator: React.FC<{
  sessionId: string | null | undefined;
}> = ({ sessionId }) => {
  const { t } = useI18n();
  const sessionKey =
    sessionId && !sessionId.startsWith('__pending') ? sessionId : null;
  const [tasks, setTasks] = useState<ToolBackgroundTaskInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const sessionRef = useRef(sessionKey);
  sessionRef.current = sessionKey;

  const refresh = useCallback(async () => {
    const key = sessionRef.current;
    if (!key) {
      setTasks([]);
      return;
    }
    const next = await listToolBackgroundTasks(key);
    // 会话已切换时丢弃过期快照，不把上一会话的计数贴到当前会话
    if (sessionRef.current === key) setTasks(next);
  }, []);

  useEffect(() => {
    setOpen(false);
    void refresh();
    if (!sessionKey) return;
    const id = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [sessionKey, refresh]);

  // 有条目时 500ms 滴答，让面板内时长走字（轮询仍是状态真源；
  // tick 口径钉死 500ms，2026-11-02 整波收口裁定，与工具行同口径）
  useEffect(() => {
    if (tasks.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [tasks.length]);

  const handleCancel = useCallback(
    async (callId: string) => {
      setCancellingId(callId);
      await cancelToolBackgroundTask(callId);
      setCancellingId((cur) => (cur === callId ? null : cur));
      // 无论取消是否生效都以注册表快照为准刷新（已终态条目自然消失）
      void refresh();
    },
    [refresh]
  );

  if (!sessionKey || tasks.length === 0) return null;

  return (
    <div className={styles.root} data-testid="tool-background-indicator">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={styles.pill}
        aria-expanded={open}
        aria-label={t('tool.background.pillAria', { count: tasks.length })}
        onClick={() => {
          setOpen((v) => !v);
          void refresh();
        }}
      >
        <span className={styles.dot} aria-hidden="true" />
        {t('tool.background.pillLabel', { count: tasks.length })}
      </Button>
      {open ? (
        <div
          className={styles.panel}
          role="group"
          aria-label={t('tool.background.listAria')}
        >
          {tasks.map((task) => (
            <div key={task.callId} className={styles.row}>
              <span className={styles.name}>
                {task.toolName || task.callId}
              </span>
              <span className={styles.elapsed}>
                {taskElapsedLabel(t, task, now)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={cancellingId === task.callId}
                onClick={() => {
                  void handleCancel(task.callId);
                }}
              >
                {cancellingId === task.callId
                  ? t('tool.background.cancelling')
                  : t('tool.background.cancel')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

ToolBackgroundIndicator.displayName = 'ToolBackgroundIndicator';
