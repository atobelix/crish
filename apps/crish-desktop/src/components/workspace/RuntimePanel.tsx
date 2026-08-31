import React, { useEffect, useState } from 'react';
import styles from './RuntimePanel.module.css';
import {
  useSettingsField,
  selectScheduledTasks,
  selectTokenUsage,
} from '../../store/storeAccess';
import { useEngineState } from '../../hooks/useEngineState';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { usePersistenceStatus } from '../../hooks/usePersistenceStatus';
import { RuntimeSection } from './RuntimeSection';
import { LiveTasksSection } from './LiveTasksSection';
import { BgTasksSection } from './BgTasksSection';
import { TimerCronSection } from './TimerCronSection';
import { ApprovalSection } from './ApprovalSection';
import { PlansSection } from './PlansSection';
import { useRuntimePanelData } from './useRuntimePanelData';
import { SessionCacheStatsPanel } from './SessionCacheStatsPanel';
import { useCacheEventsStore } from '../../api/chat-bridge/handlers/cacheEventsStore';
import { useSecurityAuditStore } from '../../api/chat-bridge/handlers/securityAuditStore';
import { SecurityAuditSection } from './SecurityAuditSection';
import { TrashSection } from './TrashSection';
import { FlowDagView } from './FlowDagView';
import { useFlowDagVisible } from '../../hooks/useFlowDagVisible';
import { connectionManager } from '../../services/ConnectionManager';
import { Button, Tooltip } from '../ui';
import {
  formatEngineStatusFull,
  formatEngineStatusShort,
  formatEngineStatusTitle,
  formatUsageRingAria,
  isReadyStatus,
} from './runtimePanelLib';

interface RuntimePanelProps {
  className?: string;
  wsId?: string;
  onShowToast?: (msg: string) => void;
}

export const RuntimePanel: React.FC<RuntimePanelProps> = () => {
  const tokenUsage = useSettingsField(selectTokenUsage);
  const cronJobs = useSettingsField(selectScheduledTasks);
  const ds = useEngineState();
  // D2：连接态真源 = errorStore.connectionStatus（useEngineState 已去 engineOnline）
  const connectionStatus = useConnectionStatus();
  // D-05 S1：持久化降级状态（批写 Fail-Open 可感知；healthy 时零渲染）
  const persistenceStatus = usePersistenceStatus();
  const data = useRuntimePanelData();
  const cachePanel = useCacheEventsStore();
  const auditEntries = useSecurityAuditStore((s) => s.entries);

  // T-D-12：编排图功能开关（localStorage 直读键 crish_flow_dag_visible，
  // 默认关；关闭时区段零挂载零请求零事件订阅——可随时下线）。
  const flowDagVisible = useFlowDagVisible();

  // T-48：冷缓存 tick——最近一 run 的 warmUntilMs 已过期时提示
  // 「下次将重发 ~X tokens」（每 run 只提示一次，store 内去重）。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    useCacheEventsStore.getState().tickColdCheck(now);
  }, [now]);

  if (ds.loading) {
    return (
      <div
        className={`${styles.panel} ${styles.isLoading}`}
        role="status"
        aria-busy="true"
        aria-label="加载运行状态"
      >
        <div className={`loading-spinner ${styles.spinner}`} aria-hidden />
        <span className={`${styles.empty} ${styles.emptyTight}`}>加载中…</span>
      </div>
    );
  }

  return (
    <div className={styles.panel} role="region" aria-label="运行状态">
      {/* 引擎状态已在 float header 展示；面板内仅一行精简状态。
          T5-1：崩溃域（engine_crashed）呈现「引擎无响应」+ 自动重连
          入口——不给「重启引擎」按钮（进程内架构重启 = 整个 Tauri
          重启，超出战役范围，产品待决明示不做） */}
      <RuntimeSection
        titleId="rt-sec-engine"
        title="引擎"
        modifier="sectionEngine"
        actions={
          <Tooltip content={formatEngineStatusTitle(connectionStatus)}>
            <div
              className={styles.engineStatus}
              role="status"
              aria-live="polite"
              aria-label={formatEngineStatusFull(connectionStatus)}
            >
              <span
                className={`${styles.dot} ${isReadyStatus(connectionStatus) ? styles.on : styles.off}`}
                aria-hidden
              />
              <span className={`${styles.rowMeta} ${styles.engineMeta}`}>
                {formatEngineStatusShort(connectionStatus)}
              </span>
              {connectionStatus === 'engine_crashed' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void connectionManager.reconnect()}
                >
                  自动重连
                </Button>
              ) : null}
            </div>
          </Tooltip>
        }
      />

      {/* D-05 S1：批写降级最小展示槽——仅在非 healthy 时渲染；
          诚实文案（描述现状「暂存本地」，不承诺已同步、不宣称数据丢失） */}
      {persistenceStatus !== 'healthy' ? (
        <div
          className={styles.persistenceWarning}
          data-persistence-status={persistenceStatus}
          role="status"
          aria-live="polite"
        >
          <span className={styles.dot} aria-hidden />
          存储降级中：会话数据正在暂存本地
        </div>
      ) : null}

      <RuntimeSection
        titleId="rt-sec-usage"
        title="用量"
        modifier="sectionUsage"
        count={{
          label: `${data.tokenPercent}%`,
          ariaLabel: formatUsageRingAria(data.tokenPercent),
        }}
      >
        <div className={`${styles.usage} ${styles.usageCompact}`}>
          <div className={styles.usageStats}>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>输入</span>
              <span className={styles.statValue}>
                {tokenUsage.input.toLocaleString()}
              </span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>输出</span>
              <span className={styles.statValue}>
                {tokenUsage.output.toLocaleString()}
              </span>
            </div>
            <div className={`${styles.statRow} ${styles.isTotal}`}>
              <span className={styles.statLabel}>费用</span>
              <span className={styles.statValue}>
                {'$'}
                {data.estimated.toFixed(4)}
              </span>
            </div>
          </div>
        </div>
      </RuntimeSection>

      {/* T-48：会话级缓存统计接线——cache 三事件 → cacheEventsStore →
          SessionCacheStatsPanel（累计 runStats + 预警 + 冷缓存提示） */}
      <SessionCacheStatsPanel
        stats={cachePanel.runStats}
        alerts={cachePanel.alerts}
        coldHint={cachePanel.coldHint}
      />

      <LiveTasksSection
        liveTasks={data.liveTasks}
        countLabel={data.liveCountLabel}
        onFocusSession={data.focusSession}
      />

      <BgTasksSection
        bgTasks={ds.bgTasks}
        countLabel={data.bgCountLabel}
      />

      {/* L2：定时/Cron 数据面展示——timer-fired/timer-cancelled/cron-fired
          事件经 taskEventHandlers 摘要订阅（事件驱动更新，无事件空态） */}
      <TimerCronSection />

      <ApprovalSection
        approvals={ds.pendingApprovals}
        countLabel={data.approvalCountLabel}
        onFocusSession={data.focusSession}
      />

      <TrashSection />

      <SecurityAuditSection entries={auditEntries} />

      {/* T-D-12：编排图区段（DAG 只读可视化；开关默认关——
          关闭时零挂载、零查询请求、零事件订阅，可下线锚点） */}
      {flowDagVisible ? <FlowDagView /> : null}

      <PlansSection
        workflows={ds.workflows}
        cronJobs={cronJobs}
        planCount={data.planCount}
        countLabel={data.planCountLabel}
      />
    </div>
  );
};
