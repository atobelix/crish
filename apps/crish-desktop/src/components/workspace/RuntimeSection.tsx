/**
 * RuntimePanel 区段基座：section 头（标题 + 可选计数 + 可选操作）+ 内容插槽。
 * 空态文案由各业务 Section 传入（empty），无 body 内容时传 null。
 */
import React from 'react';
import styles from './RuntimePanel.module.css';

export type RuntimeSectionCount = {
  /** 可见计数（0 时上层不传，避免空数字噪音） */
  label: string;
  /** 读屏播报（如「3 个进行中」） */
  ariaLabel: string;
};

export type RuntimeSectionProps = {
  /** aria-labelledby 锚点 id（与 h4 一致） */
  titleId: string;
  title: string;
  count?: RuntimeSectionCount | null;
  /** 头部右侧附加内容（引擎状态点 / 管理按钮等） */
  actions?: React.ReactNode;
  /** 空态内容（null = 不渲染空态块；children 为空时整个 body 不渲染） */
  empty?: React.ReactNode;
  /** 区段修饰类（如 sectionEngine / sectionUsage） */
  modifier?: string;
  children?: React.ReactNode;
};

export const RuntimeSection: React.FC<RuntimeSectionProps> = ({
  titleId,
  title,
  count,
  actions,
  empty,
  modifier,
  children,
}) => {
  return (
    <section
      className={`${styles.section}${modifier ? ` ${styles[modifier]}` : ''}`}
      aria-labelledby={titleId}
    >
      <div className={styles.sectionHead}>
        <h4 id={titleId} className={styles.sectionTitle}>
          {title}
        </h4>
        {count ? (
          <span className={styles.rowMeta} aria-live="polite" aria-label={count.ariaLabel}>
            {count.label}
          </span>
        ) : null}
        {actions}
      </div>
      {empty != null ? (
        <div className={styles.empty} role="status">
          {empty}
        </div>
      ) : (
        children
      )}
    </section>
  );
};
