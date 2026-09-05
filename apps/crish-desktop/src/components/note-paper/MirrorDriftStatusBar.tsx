/**
 * @deprecated 仅保留用于 mirrorThreeWayBridge.test.tsx 单元测试；生产主编辑视图 NotePaperStrictPanel 已彻底切断 DOM 挂载与引用
 * MirrorDriftStatusBar — A-INV-02 镜像漂移状态 + 三路操作入口骨架
 *
 * ## 完成定义（本包方向子集）
 * - 可点名：**镜像漂移状态展示** + **三路入口**（接受镜像 / 保留文档 / 标记冲突）
 * - 注入 `report` 即可测；**不**在本组件内实现 poll / OS watcher
 * - 动作经 `resolveThreeWayAction`（X-05：禁静默 DropUnacked）
 *
 * ## 诚实边界
 * - 底层可能仍是 **poll** 或 **OS 事件** hint → detect；`data-watch-source` 如实标注
 * - **≠ inotify 产品满关**；有本条 **≠** OS watcher 生产全链路
 * - **≠ A-INV-02 全产品满关**（无 apply 落盘；import 仅提案）
 * - **≠ EL-03**（禁止把本 UI 写成大文档存活关闭）
 * - onAction 收到决策后由上层经 `submitThreeWayViaMirrorIpc` 调
 *   `note_import_mirror_proposal`；本组件 **从不** 默认 confirmDiscardUnpushed=true
 * - **诚实未做**：timer+OS 双开 debounce；产品自动 detect 调度
 * - 空态装配：经 `WorkspaceEmptyState` 的 `showMirrorDriftBar` /
 *   `mirrorDriftReport` **opt-in**（默认关，避免噪声）
 *
 * surface 旁挂：note-paper Strict footer 或独立挂载。
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Button } from '../ui';
import { Tooltip } from '../ui/Tooltip/Tooltip';
import {
  A_INV_02_UI_DIRECTION_ID,
  isDriftAttention,
  MIRROR_DRIFT_CLASS_LABEL,
  MIRROR_DRIFT_UI_HONESTY,
  MIRROR_WATCH_SOURCE_LABEL,
  resolveThreeWayAction,
  shouldShowThreeWayActions,
  THREE_WAY_ACTION_LABEL,
  type MirrorDriftReportView,
  type MirrorThreeWayAction,
  type MirrorWatchSource,
  type ThreeWayDecision,
} from './mirrorDriftUi';
import styles from './NotePaperPanel.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type MirrorDriftStatusBarProps = {
  /** 漂移报告；null/undefined = 未检测 / 无数据 */
  report: MirrorDriftReportView | null | undefined;
  /**
   * 未推送本地 op 数（X-05）。
   * 默认 0；**有 unpushed 时「接受镜像」须二次确认才映射 DropUnacked**。
   */
  unpushedOpCount?: number;
  /**
   * 检测来源诚实标注（poll / os_event / injected）。
   * 默认 `unknown`；**禁止** 无 OS 时写 os_event 冒充满关。
   */
  watchSource?: MirrorWatchSource;
  /**
   * 三路决策回调（骨架出口）。
   * 上层可再调 store import；本条 **不** 直接 apply / 不静默盖 unpushed。
   */
  onAction?: (decision: ThreeWayDecision) => void;
  /** 额外 className */
  className?: string;
  /** 是否显示诚实脚注（默认 true） */
  showHonestyNote?: boolean;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * 镜像漂移状态条：分类徽章 + 可选三路按钮。
 * 无 report 时展示 idle（未检测），不假装已满关。
 */
export const MirrorDriftStatusBar: React.FC<MirrorDriftStatusBarProps> = ({
  report,
  unpushedOpCount = 0,
  watchSource = 'unknown',
  onAction,
  className,
  showHonestyNote = true,
}) => {
  const [lastDecision, setLastDecision] = useState<ThreeWayDecision | null>(
    null
  );
  /** 用户是否已显式确认丢弃 unpushed（仅本会话；默认 false） */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [gateMessage, setGateMessage] = useState<string | null>(null);

  const cls = report?.class;
  const attention = isDriftAttention(cls);
  const showActions = shouldShowThreeWayActions(cls);
  const unpushed = Math.max(0, unpushedOpCount | 0);
  const sourceLabel = MIRROR_WATCH_SOURCE_LABEL[watchSource];

  const statusLabel = useMemo(() => {
    if (!report) return '未检测';
    return MIRROR_DRIFT_CLASS_LABEL[report.class];
  }, [report]);

  const runAction = useCallback(
    (action: MirrorThreeWayAction) => {
      const decision = resolveThreeWayAction(action, {
        unpushedOpCount: unpushed,
        confirmDiscardUnpushed: confirmDiscard,
        driftClass: cls,
      });
      setLastDecision(decision);
      if (!decision.ok) {
        setGateMessage(decision.reason);
        onAction?.(decision);
        return;
      }
      setGateMessage(null);
      // 成功提交后清掉确认位，避免下次误用 DropUnacked
      if (decision.discardsUnpushed) {
        setConfirmDiscard(false);
      }
      onAction?.(decision);
    },
    [cls, confirmDiscard, onAction, unpushed]
  );

  const rootClass = [
    styles.mirrorDriftBar,
    attention ? styles.mirrorDriftBarAttention : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={rootClass}
      data-testid="mirror-drift-status-bar"
      data-package-direction={A_INV_02_UI_DIRECTION_ID}
      data-drift-class={cls ?? 'idle'}
      data-watch-source={watchSource}
      data-unpushed={String(unpushed)}
      data-attention={attention ? 'true' : 'false'}
      data-three-way={showActions ? 'true' : 'false'}
      data-confirm-discard={confirmDiscard ? 'true' : 'false'}
      data-el03="not-claimed"
      data-inotify-full="not-claimed"
      role="status"
      aria-label={`镜像漂移：${statusLabel}`}
    >
      <div className={styles.mirrorDriftRow}>
        <span
          className={styles.mirrorDriftBadge}
          data-testid="mirror-drift-class"
        >
          镜像：{statusLabel}
        </span>
        <Tooltip content={MIRROR_DRIFT_UI_HONESTY}>
          <span
            className={styles.mirrorDriftMeta}
            data-testid="mirror-drift-watch-source"
          >
            src={sourceLabel}
          </span>
        </Tooltip>
        {report?.pendingLag !== undefined ? (
          <span
            className={styles.mirrorDriftMeta}
            data-testid="mirror-drift-lag"
          >
            lag={report.pendingLag}
          </span>
        ) : null}
        {unpushed > 0 ? (
          <span
            className={styles.mirrorDriftUnpushed}
            data-testid="mirror-drift-unpushed"
          >
            unpushed={unpushed}
          </span>
        ) : null}
      </div>

      {showActions ? (
        <div
          className={styles.mirrorDriftActions}
          data-testid="mirror-drift-three-way"
          role="group"
          aria-label="镜像三路操作"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.mirrorDriftActionBtn}
            data-testid="mirror-drift-accept"
            data-action="accept_mirror"
            onClick={() => {
              runAction('accept_mirror');
            }}
            aria-label={THREE_WAY_ACTION_LABEL.accept_mirror}
          >
            {THREE_WAY_ACTION_LABEL.accept_mirror}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.mirrorDriftActionBtn}
            data-testid="mirror-drift-keep-doc"
            data-action="keep_doc"
            onClick={() => {
              runAction('keep_doc');
            }}
            aria-label={THREE_WAY_ACTION_LABEL.keep_doc}
          >
            {THREE_WAY_ACTION_LABEL.keep_doc}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.mirrorDriftActionBtn}
            data-testid="mirror-drift-mark-conflict"
            data-action="mark_conflict"
            onClick={() => {
              runAction('mark_conflict');
            }}
            aria-label={THREE_WAY_ACTION_LABEL.mark_conflict}
          >
            {THREE_WAY_ACTION_LABEL.mark_conflict}
          </Button>
          {unpushed > 0 ? (
            <label
              className={styles.mirrorDriftConfirm}
              data-testid="mirror-drift-confirm-discard"
            >
              <input
                type="checkbox"
                checked={confirmDiscard}
                onChange={(e) => {
                  setConfirmDiscard(e.target.checked);
                  setGateMessage(null);
                }}
                data-testid="mirror-drift-confirm-discard-input"
              />
              显式丢弃 unpushed 后接受镜像（X-05）
            </label>
          ) : null}
        </div>
      ) : null}

      {gateMessage ? (
        <div
          className={styles.mirrorDriftGate}
          data-testid="mirror-drift-gate"
          role="alert"
        >
          {gateMessage}
        </div>
      ) : null}

      {lastDecision?.ok ? (
        <div
          className={styles.mirrorDriftMeta}
          data-testid="mirror-drift-last-decision"
          data-strategy={lastDecision.strategy ?? 'none'}
          data-calls-import={lastDecision.callsImport ? 'true' : 'false'}
          data-discards-unpushed={
            lastDecision.discardsUnpushed ? 'true' : 'false'
          }
        >
          已选：{THREE_WAY_ACTION_LABEL[lastDecision.action]}
          {lastDecision.strategy
            ? ` → ${lastDecision.strategy}`
            : '（不 import）'}
        </div>
      ) : null}

      {showHonestyNote ? (
        <p
          className={styles.mirrorDriftHonesty}
          data-testid="mirror-drift-honesty"
        >
          {MIRROR_DRIFT_UI_HONESTY}
        </p>
      ) : null}
    </div>
  );
};

export default MirrorDriftStatusBar;
