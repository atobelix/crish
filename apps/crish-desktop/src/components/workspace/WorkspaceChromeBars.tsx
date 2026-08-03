/**
 * 工作台双行标签（功能实体，对照参考图）：
 * - 工作区行：文件夹式顶圆角 tab（项目 / 默认工作区）
 * - 会话行：Obsidian soft pill + 右侧轻动作区
 *
 * 与侧栏列表同步：点会话会挂标签；关标签不删会话。
 * inset 模式下两行都在内容卡顶，app-header 只放壳层控件。
 */
import React from 'react';
import styles from './WorkspaceChromeBars.module.css';
import { WorkspaceStrip } from './WorkspaceStrip';
import { SessionStrip } from './SessionStrip';
import type { WorkspaceChromeProps } from './workspaceChromeHooks';

export { };

/** 两行一体：inset 内容卡顶（工作区 folder + 会话 pill） */
export const WorkspaceChromeBars: React.FC<WorkspaceChromeProps> = (props) => {
  if (props.variant === 'workspace') return <WorkspaceStrip {...props} />;
  if (props.variant === 'sessions') return <SessionStrip {...props} />;
  return (
    <div
      className={`${styles.wsChrome} ws-chrome ${props.className || ''}`}
      role="navigation"
      aria-label="工作台标签"
    >
      <WorkspaceStrip {...props} />
      <SessionStrip {...props} />
    </div>
  );
};
