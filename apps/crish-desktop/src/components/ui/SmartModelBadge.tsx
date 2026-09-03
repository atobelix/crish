import React, { useMemo } from 'react';
import styles from './SmartModelBadge.module.css';
import { abbreviateModel, type ModelAbbrResult } from '../../api/modelAbbreviation';
import { Tooltip } from './Tooltip/Tooltip';

export interface SmartModelBadgeProps {
  /** 模型原始 ID（如 meta/muse-spark-1.2-contributor, deepseek-ai/deepseek-v4-flash-0731） */
  modelId: string;
  /** 可选自定义展示名称（如果用户已显式配置） */
  displayName?: string | null;
  /** 是否展示绿色在线就绪圆点，默认为 false */
  showDot?: boolean;
  /** 附加外层 CSS 类名 */
  className?: string;
  /** 固定强制显示某一档位（缺省则交由 CSS @container 自适应） */
  forceTier?: 'standard' | 'compact' | 'micro';
}

/**
 * 现代零重排智能模型徽标组件（SmartModelBadge）
 * 
 * 核心设计：
 * 1. 采用原生 CSS 容器查询（@container），零 JS 测距开销，杜绝 Layout Thrashing；
 * 2. 内部渲染三段式真实文本 Span，保持原生可复制、划词选中与无障碍支持；
 * 3. 严格遵循 AGENTS.md §12 规范，悬停通过自定义 <Tooltip> 无损溯源原始 ID。
 */
export const SmartModelBadge: React.FC<SmartModelBadgeProps> = ({
  modelId,
  displayName,
  showDot = false,
  className = '',
  forceTier,
}) => {
  const abbr: ModelAbbrResult = useMemo(() => {
    return abbreviateModel(modelId, { displayName });
  }, [modelId, displayName]);

  const tooltipContent = useMemo(() => {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontWeight: 600 }}>{abbr.standard}</div>
        <div style={{ fontSize: 10, opacity: 0.8, fontFamily: 'monospace' }}>
          原始标识: {modelId}
        </div>
      </div>
    );
  }, [abbr.standard, modelId]);

  return (
    <div className={`${styles.badgeContainer} ${className}`.trim()}>
      <Tooltip content={tooltipContent} side="top" delayShow={200}>
        <div className={styles.capsule} role="status" aria-label={abbr.standard}>
          {showDot ? <span className={styles.statusDot} aria-hidden="true" /> : null}

          {forceTier === 'standard' ? (
            <span>{abbr.standard}</span>
          ) : forceTier === 'compact' ? (
            <span>{abbr.compact}</span>
          ) : forceTier === 'micro' ? (
            <span>{abbr.micro}</span>
          ) : (
            <>
              <span className={styles.standardSpan}>{abbr.standard}</span>
              <span className={styles.compactSpan}>{abbr.compact}</span>
              <span className={styles.microSpan}>{abbr.micro}</span>
            </>
          )}
        </div>
      </Tooltip>
    </div>
  );
};
