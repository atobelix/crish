/**
 * WorkflowConfirmCard —— 定时任务配置确认卡片（独立业务交互组件）。
 *
 * 模型在对话流输出 `json:workflow-payload` 围栏后，本卡片将结构化载荷
 * 渲染为「确认创建并激活 / 修改配置」交互面；点击确认经
 * registerWorkflowFromGrillMe 走 create-workflow 落盘。
 */
import React, { useCallback, useMemo, useState } from 'react';

import styles from './WorkflowConfirmCard.module.css';
import { Button, Tooltip } from '@/components/ui';
import { useToast } from '../../services/toast/ToastContext';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';
import { useSessionStore } from '../../store/storeAccess';
import {
  registerWorkflowFromGrillMe,
  type WorkflowConfirmPayload,
} from '../../api/workflow-api/workflowConfirm';
import {
  clearWorkflowConfirmSignaturesForSession,
  getConfirmedBucket,
  getPayloadSignature,
} from '../../api/workflow-api/workflowConfirmSignatures';
import { AppIcon } from '@/components/ui/icons';

export { clearWorkflowConfirmSignaturesForSession };

export interface WorkflowConfirmCardProps {
  payload: WorkflowConfirmPayload;
}

/** 调度摘要（卡片辅助行：manual / daily HH:mm / intervalMinutes N 分 / cron） */
function scheduleSummary(payload: WorkflowConfirmPayload): string {
  switch (payload.scheduleType) {
    case 'daily':
      return `每日 ${payload.dailyTime ?? '09:00'}`;
    case 'intervalMinutes':
      return `每 ${payload.intervalMinutes ?? 30} 分钟`;
    case 'cron':
      return `Cron: ${payload.cronExpression ?? ''}`;
    default:
      return '手动触发';
  }
}

export const WorkflowConfirmCard: React.FC<WorkflowConfirmCardProps> =
  React.memo(function WorkflowConfirmCard({ payload }) {
    const toast = useToast();
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const sig = useMemo(() => getPayloadSignature(payload), [payload]);
    const isAlreadyConfirmed = getConfirmedBucket(activeSessionId).has(sig);

    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<'idle' | 'ok' | 'error'>(
      isAlreadyConfirmed ? 'ok' : 'idle'
    );
    const [errorMsg, setErrorMsg] = useState('');

    const handleConfirm = useCallback(async () => {
      if (busy || result === 'ok') return;
      setBusy(true);
      setResult('idle');
      setErrorMsg('');
      try {
        const res = await registerWorkflowFromGrillMe(payload);
        if (res.ok) {
          getConfirmedBucket(activeSessionId).add(sig);
          setResult('ok');
          toast.success('定时任务已创建并激活');
        } else {
          setResult('error');
          const msg = res.error || '创建失败，请检查引擎是否就绪';
          setErrorMsg(msg);
          toast.error(msg);
        }
      } catch (e) {
        setResult('error');
        const msg = e instanceof Error ? e.message : '创建失败';
        setErrorMsg(msg);
        toast.error(msg);
      } finally {
        setBusy(false);
      }
    }, [busy, payload, toast, sig, result, activeSessionId]);

    /** 修改配置：把载荷回填到输入框并引导继续对齐（不落盘） */
    const handleModify = useCallback(() => {
      const sid = useSessionStore.getState().activeSessionId;
      if (!sid) {
        toast.warning('无活跃会话，无法回填配置');
        return;
      }
      sessionDraftManager.injectSeed({
        targetSessionId: sid,
        content: `请帮我调整上面的定时任务配置（当前建议：${payload.name} / ${scheduleSummary(payload)}）。`,
        mode: 'safe_seed',
        metadata: { source: 'slash_command', title: '修改定时任务配置' },
      });
    }, [payload, toast]);

    return (
      <div
        className={styles.confirmCard}
        data-testid="workflow-confirm-card"
        role="region"
        aria-label="定时任务确认卡片"
      >
        <div className={styles.confirmHead}>
          <span className={styles.iconSlot} aria-hidden>
            <AppIcon name="clock" size={14} />
          </span>
          <span className={styles.titleText}>定时任务配置确认</span>
          {result === 'ok' ? (
            <Tooltip content="已成功创建">
              <AppIcon
                name="check-circle"
                size={14}
                className={styles.okIcon}
                data-testid="confirm-ok"
              />
            </Tooltip>
          ) : null}
          {result === 'error' ? (
            <Tooltip content={errorMsg || '创建失败'}>
              <AppIcon
                name="alert-circle"
                size={14}
                className={styles.failIcon}
                data-testid="confirm-error"
              />
            </Tooltip>
          ) : null}
        </div>
        <div className={styles.confirmBody}>
          <div className={styles.confirmTaskName}>{payload.name}</div>
          <div className={styles.confirmScheduleRow}>
            <AppIcon
              name="calendar-clock"
              size={13}
              className={styles.scheduleIcon}
              aria-hidden
            />
            <span>{scheduleSummary(payload)}</span>
          </div>
          <pre className={styles.confirmPromptBlock} aria-label="执行指令">
            {payload.prompt}
          </pre>
          {payload.cwd ? (
            <div className={styles.confirmCwdRow}>
              <AppIcon
                name="folder"
                size={13}
                className={styles.folderIcon}
                aria-hidden
              />
              <span className={styles.confirmCwdPath}>{payload.cwd}</span>
            </div>
          ) : null}
          <div className={styles.confirmActions}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleModify}
              disabled={busy}
            >
              修改配置
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleConfirm}
              disabled={busy || result === 'ok'}
            >
              {busy
                ? '创建中...'
                : result === 'ok'
                  ? '已创建'
                  : '确认创建并激活'}
            </Button>
          </div>
        </div>
      </div>
    );
  });

WorkflowConfirmCard.displayName = 'WorkflowConfirmCard';
