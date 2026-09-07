/**
 * ContextInjectionBlock —— 注入卡片容器组件（批量堆栈 + 无障碍 region 封装）。
 *
 * 挂载于消息时间线注入块：一次渲染该块内全部注入项；空集合返回 null。
 * 共享交互 props（activeSessionId/折叠映射/回调）透传给每张 CompactInjectionRow。
 */
import React from 'react';
import styles from './ContextInjectionBlock.module.css';
import type { ContextInjectionBlockProps } from './contextInjectionTypes';
import { CompactInjectionRow } from './CompactInjectionRow';
import { isContextStateInjection } from './contextInjectionUtils';

export const ContextInjectionBlock: React.FC<ContextInjectionBlockProps> =
  React.memo(function ContextInjectionBlock({
    injections,
    className,
    ...sharedProps
  }) {
    if (!injections || injections.length === 0) return null;
    const isAllState = injections.every(isContextStateInjection);
    if (isAllState) {
      return (
        <div
          className={`${styles.stateNoticeStack} ${className || ''}`}
          role="none"
        >
          {injections.map((inj) => (
            <CompactInjectionRow
              key={inj.id}
              rowKey={inj.id}
              injection={inj}
              {...sharedProps}
            />
          ))}
        </div>
      );
    }
    return (
      <div
        className={`${styles.injectionStack} ${className || ''}`}
        role="region"
        aria-label={`系统上下文注入（共 ${injections.length} 项）`}
      >
        {injections.map((inj) => (
          <CompactInjectionRow
            key={inj.id}
            rowKey={inj.id}
            injection={inj}
            {...sharedProps}
          />
        ))}
      </div>
    );
  });

ContextInjectionBlock.displayName = 'ContextInjectionBlock';
