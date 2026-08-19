/**
 * 电脑操作面板：会话开关（显式开启/关闭）+
 * 三态会话指示（Idle/BrowserActive/DesktopActive 对应 ActivationGate）+
 * 感知预览占位。
 *
 * 安全门槛（04 §4）：
 * - 启用走风险确认对话框（§4.1 ①：说明可注入本机全部输入/截屏、停止方式），
 *   确认后才调用 enable；
 * - 三态指示呈现 ActivationGate 状态广播（§2 S3 项 4；经 useComputerSession
 *   订阅 computer://state-changed，正常由引擎状态广播驱动；missing 仅兜底）。
 *
 * 接线点（已登记，与 Rust 侧 `command_manifest.rs` / `main.rs` 三命令同步）：
 * - 命令桥：api/computerSessionApi.ts（computer_session_enable /
 *   computer_session_disable / computer_status + 事件
 *   computer://state-changed）；正常路径走引擎落盘与状态广播；
 * - 感知预览：UIA 快照（computer_snapshot）/ 截图回显（computer_screenshot，
 *   动作后回显）由引擎提供；当前预览区为占位，后续接线扩展；
 * - 装配点：经工作区入口 `<ComputerPanel />` 装配。
 */
import React, { useState } from 'react';
import { AlertTriangle, Power, ScanEye } from 'lucide-react';
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
  const { enabled, activation, wired, busy, enable, disable } =
    useComputerSession();

  // 启用风险确认对话框（04 §4.1 ①：风险说明 + 显式确认后才授权）
  const [enableConfirmOpen, setEnableConfirmOpen] = useState(false);

  const enableReady = canEnableComputerSession(enabled) && !busy;
  const disableReady = canDisableComputerSession(enabled) && !busy;

  return (
    <section className={styles.section} aria-label="电脑操作">
      <header className={styles.header}>
        <span className={styles.title}>电脑操作</span>
        <span className={styles.hint}>
          会话级显式开启 · 与浏览器会话互斥
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
              ? '电脑操作会话已开启，AI 可注入本机输入。'
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

      {/* ── 感知预览（占位） ── */}
      <div className={styles.block}>
        <h4 className={styles.blockTitle}>
          <ScanEye size={13} strokeWidth={1.75} aria-hidden /> 感知预览
        </h4>
        <p className={styles.placeholderText}>
          UIA 快照（computer_snapshot）与动作回显截图（computer_screenshot）
          由引擎提供；当前预览区为占位，后续扩展在此展示。
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
            屏幕截图）。开启即承担责任，可通过输入框停止按钮随时中止。 确认继续？
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
    </section>
  );
};
