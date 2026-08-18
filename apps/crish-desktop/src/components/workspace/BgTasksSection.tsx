import { useToast } from '../../services/toast/ToastContext';
/**
 * RuntimePanel 后台常驻区段：后台任务列表 + 打开终端输出（防连点）。
 * 打开是可预期操作不 toast；读取失败仅错误提示并回退展示。
 * suspicious 装配：轮询快照含 suspicious:true 时行内展示「疑似卡死」标记
 * （34 文档 DD5-T2a 前端装配测试配套；走 task.suspicious 字段路径）。
 */
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './RuntimePanel.module.css';
import { Tooltip } from '../ui';
import {
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  backgroundTaskStateLabel,
  getBackgroundTaskOutput,
  openBackgroundTaskInTerminal,
  type BackgroundTaskInfo,
} from '../../api/backgroundTasksApi';
import {
  emptyBgTasksHint,
  formatBgTaskMeta,
} from './runtimePanelLib';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { SUSPICIOUS_TASK_TEXT } from '../bg-tasks/bgTaskCardLib';

export type BgTasksSectionProps = {
  bgTasks: BackgroundTaskInfo[];
  countLabel: string | null;
};

export const BgTasksSection: React.FC<BgTasksSectionProps> = ({
  bgTasks,
  countLabel,
  }) => {
  const { showToast: _showToast } = useToast();
  // D2（C-10）：连接态投影（errorStore 真源），不再由 RuntimePanel props 下传
  const connectionStatus = useConnectionStatus();
  const [bgOpeningId, setBgOpeningId] = useState<string | null>(null);

  const openBgTask = async (t: BackgroundTaskInfo) => {
    if (bgOpeningId) return;
    setBgOpeningId(t.id);
    try {
      const out = await getBackgroundTaskOutput(t.id);
      // 打开终端是可预期操作：不 toast；面板切换即反馈
      openBackgroundTaskInTerminal(
        t.label,
        out || t.summary || t.command || BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
      );
    } catch {
      // 仅错误提示；仍尽量打开终端展示回退内容
      openBackgroundTaskInTerminal(
        t.label,
        t.summary || t.command || '读取失败',
      );
      showToast('读取后台任务输出失败');
    } finally {
      setBgOpeningId(null);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="rt-sec-bg">
      <div className={styles.sectionHead}>
        <h4 id="rt-sec-bg" className={styles.sectionTitle}>
          后台常驻
        </h4>
        {countLabel ? (
          <span className={styles.rowMeta} aria-live="polite" aria-label={`${countLabel} 个后台任务`}>
            {countLabel}
          </span>
        ) : null}
      </div>
      {bgTasks.length === 0 ? (
        <div className={styles.empty} role="status">
          {emptyBgTasksHint(connectionStatus)}
        </div>
      ) : (
        <div
          className={`${styles.list}${bgTasks.length > 4 ? ` ${styles.listScroll}` : ''}`}
          role="list"
          aria-label="后台常驻任务"
        >
          {bgTasks.map((t) => {
            const opening = bgOpeningId === t.id;
            const stateZh = backgroundTaskStateLabel(t.state);
            const meta = formatBgTaskMeta({
              state: t.state,
              command: t.command,
              opening,
            });
            // suspicious 装配：轮询快照经 parseBackgroundTask 落地的字段，
            // true 时行内渲染「疑似卡死」标记并同步进 aria 声明
            const suspicious = t.suspicious === true;
            return (
              <Tooltip key={t.id} content="在终端中查看输出">
                <div
                  className={`${styles.row} ${styles.isClickable}${opening ? ` ${styles.isOpening}` : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t.label}，${stateZh}${suspicious ? `，${SUSPICIOUS_TASK_TEXT}` : ''}，在终端中查看输出`}
                  aria-busy={opening || undefined}
                  onClick={() => {
                    void openBgTask(t);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void openBgTask(t);
                    }
                  }}
                >
                  <div className={styles.rowMain}>
                    <Lucide.Terminal size={16} className={styles.rowIco} aria-hidden />
                    <div className={styles.rowText}>
                      <span className={styles.rowTitle}>{t.label}</span>
                      <span className={styles.rowMeta}>{meta}</span>
                      {suspicious ? (
                        <span className={styles.rowMeta}>
                          <Lucide.AlertTriangle size={12} aria-hidden />
                          {SUSPICIOUS_TASK_TEXT}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Lucide.ChevronRight size={16} className={styles.rowChevron} aria-hidden />
                </div>
              </Tooltip>
            );
          })}
        </div>
      )}
    </section>
  );
};
