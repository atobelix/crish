/**
 * 电脑操作面板（二期 P2，S5 遗留⑩）：会话开关（显式开启/关闭）+ 全局急停 +
 * 三态会话指示（Idle/BrowserActive/DesktopActive 对应 ActivationGate）+
 * 感知预览占位。
 *
 * 安全门槛（04 §4）：
 * - 启用走风险确认对话框（§4.1 ①：说明可注入本机全部输入/截屏、动作逐次
 *   审批、急停方式），确认后才调用 enable；
 * - 急停按钮常驻显眼位置（大红色 + 确认流，§4.3 ③ 面板按钮 → 同一吊销链）；
 * - 三态指示呈现 ActivationGate 状态广播（§2 S3 项 4；引擎接线前由
 *   useComputerSession 本地化维护，未接线时展示「引擎未接线」降级徽标）。
 *
 * 接线点登记（06 §8 遗留项 10）：
 * - 命令桥：api/computerSessionApi.ts（computer_session_enable /
 *   computer_session_disable / computer_estop / computer_status + 事件
 *   computer://state-changed）；Rust 侧未注册 → missing 降级本地化；
 * - 感知预览：UIA 快照（computer_snapshot）/ 截图回显（computer_screenshot，
 *   动作后回显）引擎接线后在此展示；当前为占位说明块；
 * - 装配点：引擎接线后经 PreviewCard（BrowserPanel 旁）或工作区入口
 *   `<ComputerPanel onShowToast={...} />` 一行装配（本任务纯新增，不动
 *   既有文件）。
 */
import React, { useState } from 'react';
import { AlertTriangle, OctagonX, Power, ScanEye } from 'lucide-react';
import styles from './ComputerPanel.module.css';
import { Button, ConfirmDialog, Tooltip } from '../../../components/ui';
import type { } from '../../../hooks/useToastQueue';
import { useComputerSession } from './useComputerSession';
import {
  COMPUTER_ACTIVATIONS,
  COMPUTER_ACTIVATION_DESC,
  COMPUTER_ACTIVATION_LABEL,
  COMPUTER_UNWIRED_TEXT,
  canDisableComputerSession,
  canEnableComputerSession,
  canEstopComputerSession,
  type ComputerActivation,
} from './computerPanelLib';

export interface ComputerPanelProps {
}

/** 三态指示条：未启用时全部 muted（idle 呈现「待机（未开启）」语境）。 */
function ActivationIndicator({
  enabled,
  activation,
}: {
  enabled: boolean;
  activation: ComputerActivation;
}) {
  return (
    <div className={styles.activation} role="status" aria-label="会话激活模式">
      {COMPUTER_ACTIVATIONS.map((m) => {
        const active = enabled && activation === m;
        const muted = !enabled && m !== 'idle';
        return (
          <Tooltip
            key={m}
            content={
              muted ? '会话未开启，该模式不可用' : COMPUTER_ACTIVATION_DESC[m]
            }
          >
            <span
              className={[
                styles.activationItem,
                active ? styles.activationActive : '',
                muted ? styles.activationMuted : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-mode={m}
              aria-current={active ? 'true' : undefined}
            >
              <span className={styles.activationDot} aria-hidden />
              {COMPUTER_ACTIVATION_LABEL[m]}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

export const ComputerPanel: React.FC<ComputerPanelProps> = () => {
  const { enabled, activation, wired, busy, enable, disable, estop } =
    useComputerSession();

  // 启用风险确认对话框（04 §4.1 ①：风险说明 + 显式确认后才授权）
  const [enableConfirmOpen, setEnableConfirmOpen] = useState(false);
  // 全局急停确认对话框（§4.3 ③：大红色按钮 + 确认流防误触）
  const [estopConfirmOpen, setEstopConfirmOpen] = useState(false);

  const enableReady = canEnableComputerSession(enabled) && !busy;
  const disableReady = canDisableComputerSession(enabled) && !busy;
  const estopReady = canEstopComputerSession(enabled) && !busy;

  return (
    <section className={styles.section} aria-label="电脑操作">
      <header className={styles.header}>
        <span className={styles.title}>电脑操作</span>
        <span className={styles.hint}>
          会话级显式开启 · 全动作审批 · 三级急停 · 与浏览器会话互斥
        </span>
        {!wired ? (
          <span className={styles.unwiredBadge} role="status">
            <AlertTriangle size={12} aria-hidden /> 引擎未接线
          </span>
        ) : null}
      </header>

      {/* ── 会话指示（ActivationGate 三态） ── */}
      <div className={styles.block}>
        <h4 className={styles.blockTitle}>会话指示</h4>
        <ActivationIndicator enabled={enabled} activation={activation} />
        <p className={styles.stats} role="status" aria-live="polite">
          {enabled
            ? activation === 'desktop'
              ? '电脑操作会话已开启，AI 可注入本机输入（逐次审批）。'
              : activation === 'browser'
                ? '电脑操作会话已开启，当前为浏览器会话活跃（互斥中）。'
                : '电脑操作会话已开启，待机中（无 AI 动作）。'
            : '电脑操作未开启：AI 无法注入本机输入或截屏感知（安全默认）。'}
        </p>
        {!wired ? (
          <p className={styles.unwiredText} role="status">
            {COMPUTER_UNWIRED_TEXT}
          </p>
        ) : null}
      </div>

      {/* ── 会话开关（显式开启/关闭） ── */}
      <div className={styles.block}>
        <h4 className={styles.blockTitle}>会话开关</h4>
        <div className={styles.row}>
          {enabled ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<Power size={14} aria-hidden />}
              disabled={!disableReady}
              onClick={() => {
                void disable();
              }}
              aria-label="停用电脑操作"
            >
              停用电脑操作
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="sm"
              icon={<Power size={14} aria-hidden />}
              disabled={!enableReady}
              onClick={() => setEnableConfirmOpen(true)}
              aria-label="启用电脑操作"
            >
              启用电脑操作
            </Button>
          )}
        </div>
      </div>

      {/* ── 全局急停（大红色常驻按钮 + 确认流） ── */}
      <div className={styles.block}>
        <h4 className={styles.blockTitle}>全局急停</h4>
        <Tooltip
          content={
            enabled
              ? '中止所有在途 AI 注入、停止感知源、会话回待机（需重新显式开启）'
              : '会话未开启，无在途 AI 操作无需急停'
          }
        >
          <Button
            type="button"
            variant="danger"
            size="md"
            block
            className={styles.estopButton}
            disabled={!estopReady}
            icon={<OctagonX size={18} aria-hidden />}
            onClick={() => setEstopConfirmOpen(true)}
            aria-label="全局急停"
          >
            全局急停
          </Button>
        </Tooltip>
      </div>

      {/* ── 感知预览（占位：UIA 快照 / 截图回显未接线） ── */}
      <div className={styles.block}>
        <h4 className={styles.blockTitle}>
          <ScanEye size={13} strokeWidth={1.75} aria-hidden /> 感知预览
        </h4>
        <p className={styles.placeholderText}>
          UIA 快照（computer_snapshot）与动作回显截图（computer_screenshot）
          引擎接线后在此展示；当前命令面未接线，预览暂不可用。
        </p>
      </div>

      {/* ── 启用风险确认（04 §4.1 ①） ── */}
      <ConfirmDialog
        open={enableConfirmOpen}
        title="启用电脑操作"
        description={
          <>
            启用后 AI 可<strong>注入本机全部输入</strong>（键盘 / 鼠标 /
            组合键） 并<strong>截屏感知</strong>（UIA 结构化快照 +
            屏幕截图）。每次动作 均需逐次审批（默认拒绝型）；可通过本面板
            <strong>全局急停</strong>随时中止，急停后需重新显式开启。 确认继续？
          </>
        }
        confirmLabel="确认启用"
        cancelLabel="取消"
        danger
        disabled={busy}
        onConfirm={() => {
          setEnableConfirmOpen(false);
          void enable();
        }}
        onCancel={() => setEnableConfirmOpen(false)}
      />

      {/* ── 急停确认（04 §4.3 ③） ── */}
      <ConfirmDialog
        open={estopConfirmOpen}
        title="确认全局急停"
        description={
          <>
            将<strong>中止所有在途 AI 注入</strong>（输入分块 / 拖拽分步立即
            停止）、停止感知源，会话回待机；恢复需重新显式开启。此操作不可
            恢复在途动作。确认急停？
          </>
        }
        confirmLabel="确认急停"
        cancelLabel="取消"
        danger
        disabled={busy}
        onConfirm={() => {
          setEstopConfirmOpen(false);
          void estop();
        }}
        onCancel={() => setEstopConfirmOpen(false)}
      />
    </section>
  );
};
