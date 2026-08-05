import React, { useEffect, useState } from 'react';
import styles from './RuntimePanel.module.css';
import {
  useSettingsField,
  selectScheduledTasks,
  selectTokenUsage,
} from '../../store/storeAccess';
import { useEngineState } from '../../hooks/useEngineState';
import { RuntimeSection } from './RuntimeSection';
import { LiveTasksSection } from './LiveTasksSection';
import { BgTasksSection } from './BgTasksSection';
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
import {
  formatEngineStatusFull,
  formatEngineStatusShort,
  formatEngineStatusTitle,
  formatUsageRingAria,
} from './runtimePanelLib';

interface RuntimePanelProps {
  wsId: string;
  onShowToast: (msg: string) => void;
}

/**
 * 运行状态悬浮面板（正式版 H2）壳组件：引擎/用量区段内联渲染，
 * 活动任务/后台常驻/待确认/计划由 4 个 Section 子件装配。
 * 文案纯函数见 runtimePanelLib；数据合并见 useRuntimePanelData。
 *
 * - 引擎连接 + activeRuns / pendingApprovals（get-status）
 * - 用量：本地累计；H3 可按 runId 接 snapshot
 * - 计划：workflow 列表（H3 再补 CRUD）
 * - 成功操作静默（列表/面板切换即反馈）；仅失败 toast
 */
export const RuntimePanel: React.FC<RuntimePanelProps> = ({
  wsId: _wsId,
  onShowToast,
}) => {
  const tokenUsage = useSettingsField(selectTokenUsage);
  const cronJobs = useSettingsField(selectScheduledTasks);
  const ds = useEngineState();
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
      {/* 引擎状态已在 float header 展示；面板内仅一行精简状态 */}
      <RuntimeSection
        titleId="rt-sec-engine"
        title="引擎"
        modifier="sectionEngine"
        actions={
          <div
            className={styles.engineStatus}
            role="status"
            aria-live="polite"
            aria-label={formatEngineStatusFull(ds.engineOnline)}
            title={formatEngineStatusTitle(ds.engineOnline)}
          >
            <span
              className={`${styles.dot} ${ds.engineOnline ? styles.on : styles.off}`}
              aria-hidden
            />
            <span className={`${styles.rowMeta} ${styles.engineMeta}`}>
              {formatEngineStatusShort(ds.engineOnline)}
            </span>
          </div>
        }
      />

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
        engineOnline={ds.engineOnline}
        onFocusSession={data.focusSession}
      />

      <BgTasksSection
        bgTasks={ds.bgTasks}
        countLabel={data.bgCountLabel}
        engineOnline={ds.engineOnline}
        onShowToast={onShowToast}
      />

      <ApprovalSection
        approvals={ds.pendingApprovals}
        countLabel={data.approvalCountLabel}
        onShowToast={onShowToast}
        onFocusSession={data.focusSession}
      />

      <TrashSection onShowToast={onShowToast} />

      <SecurityAuditSection entries={auditEntries} />

      {/* T-D-12：编排图区段（DAG 只读可视化；开关默认关——
          关闭时零挂载、零查询请求、零事件订阅，可下线锚点） */}
      {flowDagVisible ? <FlowDagView /> : null}

      <PlansSection
        workflows={ds.workflows}
        cronJobs={cronJobs}
        planCount={data.planCount}
        countLabel={data.planCountLabel}
        engineOnline={ds.engineOnline}
      />
    </div>
  );
};
