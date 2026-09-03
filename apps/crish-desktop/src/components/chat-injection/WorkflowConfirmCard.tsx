/**
 * WorkflowConfirmCard —— 路径 B 确认卡片（详案 05 §2.4.2 / TC-WG-05）。
 *
 * 模型在对话流输出 `json:workflow-payload` 围栏后，本卡片将结构化载荷
 * 渲染为「确认创建并激活 / 修改配置」交互面；点击确认经
 * registerWorkflowFromGrillMe 走 create-workflow 落盘（零额外 AI 轮次）。
 *
 * 视觉对齐 chat-injection 卡片族（圆角 + 语义微光 + 无重阴影），
 * 成功/失败状态以 toast + 卡片内状态徽标双通道呈现。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2, Clock } from 'lucide-react';
import styles from './ContextInjectionBlock.module.css';
import { Button, Tooltip } from '../ui';
import { useToast } from '../../services/toast/ToastContext';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';
import { useSessionStore } from '../../store/sessionStore';
import {
  registerWorkflowFromGrillMe,
  type WorkflowConfirmPayload,
} from '../../api/workflow-api/workflowConfirm';

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

// 跨组件挂载持久化已确认载荷集合，防虚拟列表卸载后重复创建
const confirmedPayloadSignatures = new Set<string>();

function getPayloadSignature(payload: WorkflowConfirmPayload): string {
  return `${payload.name}::${payload.prompt}::${payload.scheduleType}::${payload.cronExpression || payload.dailyTime || payload.intervalMinutes || ''}`;
}

export const WorkflowConfirmCard: React.FC<WorkflowConfirmCardProps> =
  React.memo(function WorkflowConfirmCard({ payload }) {
    const toast = useToast();
    const sig = useMemo(() => getPayloadSignature(payload), [payload]);
    const isAlreadyConfirmed = confirmedPayloadSignatures.has(sig);

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
          confirmedPayloadSignatures.add(sig);
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
    }, [busy, payload, toast]);

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
        className={`${styles.injectionRow} ${styles.toneSchedule}`}
        data-testid="workflow-confirm-card"
        role="region"
        aria-label="定时任务确认卡片"
      >
        <div className={styles.rowHead}>
          <div className={styles.rowHeadMain}>
            <span className={styles.iconSlot} aria-hidden>
              <Clock size={14} />
            </span>
            <span className={styles.kindBadge}>任务确认</span>
            <span className={styles.titleText}>定时任务配置确认</span>
            {result === 'ok' ? (
              <Tooltip content="已成功创建">
                <CheckCircle2
                  size={14}
                  className={styles.okIcon}
                  data-testid="confirm-ok"
                />
              </Tooltip>
            ) : null}
            {result === 'error' ? (
              <Tooltip content={errorMsg || '创建失败'}>
                <AlertCircle
                  size={14}
                  className={styles.failIcon}
                  data-testid="confirm-error"
                />
              </Tooltip>
            ) : null}
          </div>
        </div>
        <div className={styles.rowBody}>
          <div className={styles.bodyInner}>
            <div className={styles.confirmSummary}>
              <div className={styles.confirmRow}>
                <span className={styles.confirmLabel}>任务名称</span>
                <span className={styles.confirmValue}>{payload.name}</span>
              </div>
              <div className={styles.confirmRow}>
                <span className={styles.confirmLabel}>执行周期</span>
                <span className={styles.confirmValue}>
                  {scheduleSummary(payload)}
                </span>
              </div>
              <div className={styles.confirmRow}>
                <span className={styles.confirmLabel}>执行指令</span>
                <span className={`${styles.confirmValue} ${styles.confirmPrompt}`}>
                  {payload.prompt}
                </span>
              </div>
            </div>
            {errorMsg && result === 'error' ? (
              <div className={styles.confirmErrorText} role="alert">
                {errorMsg}
              </div>
            ) : null}
            <div className={styles.confirmActionRow}>
              <Button
                type="button"
                variant="primary"
                size="sm"
                loading={busy}
                disabled={result === 'ok'}
                onClick={() => void handleConfirm()}
              >
                {result === 'ok'
                  ? '已创建'
                  : busy
                    ? '创建中…'
                    : '确认创建并激活'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy || result === 'ok'}
                onClick={handleModify}
              >
                修改配置
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  });

WorkflowConfirmCard.displayName = 'WorkflowConfirmCard';
