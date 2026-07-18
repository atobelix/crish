import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import { isDemoMode } from '../api/appMode';
import styles from './ChatDemoChrome.module.css';
import { Tooltip } from './settings/SettingsUI';

interface ChatDemoChromeProps {
  handleGlobalTabClick: (cardId: string) => void;
}

/**
 * Demo-only chat chrome: context pills + Goal playground drawer.
 * Formal product mode never mounts this (caller gates with isDemoMode()).
 */
export const ChatDemoChrome: React.FC<ChatDemoChromeProps> = ({
  handleGlobalTabClick,
}) => {
  const [prVisible] = useState(true);
  /* 默认收起目标抽屉，避免演示态 footer 被 140px 卡片顶掉消息区 */
  const [activePill, setActivePill] = useState<string | null>(null);
  const [goalPaused, setGoalPaused] = useState(false);
  const [goalEditMode, setGoalEditMode] = useState(false);
  const [goalText, setGoalText] = useState(
    '自动完成系统的交互式升级与界面美化工作，包括状态栏 Ribbon、浏览器和终端模拟器的对接及验证。',
  );
  const [goalActive, setGoalActive] = useState(true);

  // Extra guard: product shell must never show demo chrome even if mis-mounted
  if (!isDemoMode()) return null;

  return (
    <>
      <div className={styles.chatContextRibbon}>
        {prVisible && (
          <Tooltip content="在右侧查看代码变更">
            <button
              type="button"
              className={`${styles.contextPill} ${styles.active}`}
              onClick={() => {
                handleGlobalTabClick('diff');
                setActivePill(null);
              }}
            >
              <Lucide.GitBranch size={14} />
              <span>变更</span>
            </button>
          </Tooltip>
        )}
        <Tooltip content="终端">
          <button
            type="button"
            className={styles.contextPill}
            onClick={() => handleGlobalTabClick('terminal')}
          >
            <Lucide.Terminal size={14} />
            <span>终端</span>
          </button>
        </Tooltip>
        {goalActive && (
          <Tooltip content="目标（演示）">
            <button
              type="button"
              className={`${styles.contextPill} ${styles.goal}${activePill === 'goal' ? ` ${styles.active}` : ''}`}
              onClick={() => setActivePill((p) => (p === 'goal' ? null : 'goal'))}
            >
              <Lucide.Target size={14} />
              <span>目标</span>
            </button>
          </Tooltip>
        )}
      </div>

      {/* Goal 抽屉：仅演示 playground，无真实引擎目标能力 */}
      {activePill === 'goal' && goalActive && (
        <div className={styles.contextDetailsDrawer}>
          <div
            className="drawer-expand-content goal-drawer-content"
            style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>当前目标</span>
                <span className="ui-badge">{goalPaused ? '已暂停' : '进行中 · 45%'}</span>
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => {
                    setGoalPaused((p) => !p);
                  }}
                >
                  {goalPaused ? <Lucide.Play size={14} /> : <Lucide.Pause size={14} />}
                  {goalPaused ? '继续' : '暂停'}
                </button>
                <Tooltip content="停止">
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost"
                    onClick={() => {
                      setGoalActive(false);
                      setActivePill(null);
                    }}
                  >
                    <Lucide.Square size={14} />
                  </button>
                </Tooltip>
                <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setActivePill(null)}>
                  <Lucide.X size={16} />
                </button>
              </div>
            </div>

            {goalEditMode ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <textarea
                  className="ui-input"
                  value={goalText}
                  onChange={(e) => setGoalText((e.target as HTMLTextAreaElement).value)}
                  rows={2}
                  style={{ resize: 'none', minHeight: 56, background: 'var(--bg-secondary)' }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    onClick={() => setGoalEditMode(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary ui-btn-sm"
                    onClick={() => {
                      setGoalEditMode(false);
                    }}
                  >
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <div
                onClick={() => setGoalEditMode(true)}
                style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'text' }}
              >
                <span style={{ color: 'var(--text-secondary)', lineHeight: 1.5, flex: 1, fontSize: 12.5 }}>
                  {goalText}
                </span>
                <Lucide.Pencil size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: 3 }} />
              </div>
            )}

            <div style={{ height: 3, background: 'var(--bg-tertiary)', borderRadius: 99, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: '45%',
                  background: 'var(--text-secondary)',
                  borderRadius: 99,
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)' }}>
              <span>已运行 4h22m</span>
              <span>预计剩余约 1 天</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
