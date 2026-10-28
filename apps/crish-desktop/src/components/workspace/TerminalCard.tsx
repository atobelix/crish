/**
 * 终端卡片组件 (V2 纯净重构版)
 *
 * 遵循 dock-split-system V2 架构准则：
 * 1. 单一职责：仅负责渲染单个与 tabId 强绑定的 xterm.js 交互式终端实例；
 * 2. 彻底清退内部假分屏：删除所有 `:split-2`、内部分割线与副格状态；
 * 3. 实例标识与 PTY 绑定：从注入的 context.panelId / tabId 获取唯一的 sessionKey；
 * 4. 容器适配：消费父级 ResizeObserver 触发 xterm fit，保持轻量高响应。
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import styles from './TerminalCard.module.css';
import {
  openNewTerminalInLeaf,
  openNewTerminalInActiveTab,
} from '../../store/storeAccess';
import {
  useLeafScope,
  useScopedSessionId,
} from '../../contexts/LeafScopeContext';
import { getWorkspacePath } from '../../api/projectStore';
import {
  InteractiveXtermTerminal,
  type InteractiveXtermHandle,
  type InteractiveXtermStatus,
} from './TerminalCard.xterm';
import { TerminalToolbar } from './TerminalToolbar';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';

export interface TerminalCardProps {
  /** 标签页唯一实例标识（直接作为 ConPTY 会话 Key） */
  tabId?: string | null;
  /** 面板 ID（兼容易有 context.panelId 透传） */
  panelId?: string | null;
  /** 会话 ID 标识 */
  sessionId?: string | null;
  /** 所在分屏叶子 ID */
  leafId?: string | null;
  /** 初始工作目录 */
  initialCwd?: string;
  /** 终端自定义标题 */
  title?: string;
  /** 组件卸载时是否销毁 PTY 进程（可选） */
  killOnUnmount?: boolean;
  /** 是否为独立常规终端（直通用户 Home 目录，无工作区锁定） */
  isStandalone?: boolean;
}

export const TerminalCard: React.FC<TerminalCardProps> = ({
  tabId: tabIdProp,
  panelId: panelIdProp,
  sessionId: sessionIdProp,
  leafId: leafIdProp,
  initialCwd,
  title: titleProp,
  killOnUnmount = false,
  isStandalone: isStandaloneProp,
}) => {
  const scope = useLeafScope();
  const scopedSessionId = useScopedSessionId(sessionIdProp);
  const effectiveLeafId = leafIdProp ?? scope.leafId;
  const boundSessionId = (scopedSessionId || '').trim() || null;
  const baseKey = boundSessionId || '_global';

  // 实例标识与 PTY 生命周期统一绑定：
  // 1. 优先使用注入的 tabId；
  // 2. 其次使用 context.panelId（若非 'terminal'，则其本身即为唯一的 tabId）；
  // 3. 兜底使用 boundSessionId 或 '_global'；
  // 彻底杜绝历史字符串自增拼接与 `:split-2` 伪 key
  const effectiveTabId =
    tabIdProp ||
    (panelIdProp && panelIdProp !== 'terminal' ? panelIdProp : null);
  const sessionKey = effectiveTabId || baseKey;

  const [cwdTick, setCwdTick] = useState(0);
  const [ptyStatus, setPtyStatus] = useState<InteractiveXtermStatus>('idle');
  const [ptyError, setPtyError] = useState('');
  const [restartToken] = useState(0);

  const reactId = useId();
  const titleId = `${reactId}-term-title`;
  const containerRef = useRef<HTMLDivElement>(null);
  const termHandleRef = useRef<InteractiveXtermHandle | null>(null);

  // 容器尺寸适配：双帧调度确保 xterm fit 铺满字符网格
  const fitTerminal = useCallback(() => {
    requestAnimationFrame(() => {
      termHandleRef.current?.fit();
      requestAnimationFrame(() => {
        termHandleRef.current?.fit();
      });
    });
  }, []);

  // 监听宿主容器 ResizeObserver 事件
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    fitTerminal();

    const ro = ResizeObserverManager.getInstance();
    const handleResize = () => {
      fitTerminal();
    };
    ro.observe(el, handleResize);

    return () => {
      ro.unobserve(el, handleResize);
    };
  }, [fitTerminal]);

  // 项目工作空间路径变更响应
  useEffect(() => {
    const onProj = () => setCwdTick((n) => n + 1);
    window.addEventListener('crish-project-changed', onProj);
    return () => window.removeEventListener('crish-project-changed', onProj);
  }, []);

  useEffect(() => {
    setPtyStatus('idle');
    setPtyError('');
  }, [sessionKey]);

  // 卸载生命周期钩子：若配置 killOnUnmount 则彻底析构 PTY
  useEffect(() => {
    return () => {
      if (killOnUnmount && sessionKey) {
        void import('../../api/ptyRegistry').then((m) => {
          void m.killPtyForSession(sessionKey);
        });
      }
    };
  }, [killOnUnmount, sessionKey]);

  const isStandalone =
    isStandaloneProp === true || sessionKey.startsWith('standalone:');

  const fullCwd = (() => {
    void cwdTick;
    // 独立常规终端模式下绝不读取 getWorkspacePath()，未指定时保持空，直通 ConPTY 解析为家目录
    if (isStandalone) {
      return initialCwd || '';
    }
    return initialCwd || getWorkspacePath() || '';
  })();

  const handlePtyStatus = useCallback(
    (status: InteractiveXtermStatus, detail?: string) => {
      setPtyStatus(status);
      if (status === 'error' && detail) setPtyError(detail);
      else if (status === 'ready') setPtyError('');
    },
    []
  );

  const handlePtyMissing = useCallback(() => {
    setPtyStatus('missing');
  }, []);

  // 工具栏动作：新建终端与清屏
  const handleNewTerminal = useCallback(() => {
    if (effectiveLeafId) {
      openNewTerminalInLeaf(effectiveLeafId);
    } else {
      openNewTerminalInActiveTab();
    }
  }, [effectiveLeafId]);

  const handleClear = useCallback(() => {
    termHandleRef.current?.clear();
  }, []);

  const ptyMissing = ptyStatus === 'missing';
  const toolbarTitle =
    titleProp ||
    (effectiveTabId && effectiveTabId !== 'terminal'
      ? `pwsh ${effectiveTabId.replace('terminal:', '')}`
      : 'pwsh');

  return (
    <div
      ref={containerRef}
      className={`${styles.panel} chat-side-panel side-panel-body term-card`}
      role="region"
      aria-labelledby={titleId}
      aria-label="终端"
      data-tab-id={effectiveTabId || ''}
      data-session-id={boundSessionId || ''}
      data-session-key={sessionKey}
      data-ux-mode="interactive"
      data-interactive-pty={ptyMissing ? 'false' : 'true'}
      data-pty-status={ptyStatus}
    >
      <span id={titleId} className={styles.srOnly}>
        终端
      </span>

      {/* 顶部操作工具栏：仅负责触发高层新终端或清屏操作 */}
      <TerminalToolbar
        title={toolbarTitle}
        onNewTerminal={handleNewTerminal}
        onClear={handleClear}
      />

      <div
        className={styles.interactiveHost}
        data-pty-host="true"
        data-pty-active={ptyMissing ? 'false' : 'true'}
        aria-label="终端区域"
      >
        {ptyMissing ? (
          <div className={styles.fallbackBanner} role="status">
            <span>
              当前环境无交互式终端（需桌面应用 PTY）。请使用正式版桌面壳。
            </span>
            {ptyError ? <span> {ptyError}</span> : null}
          </div>
        ) : (
          <div className={styles.xtermWrap}>
            <InteractiveXtermTerminal
              ref={termHandleRef}
              sessionKey={sessionKey}
              cwd={fullCwd || undefined}
              restartToken={restartToken}
              onStatusChange={handlePtyStatus}
              onPtyMissing={handlePtyMissing}
            />
          </div>
        )}
      </div>
    </div>
  );
};
