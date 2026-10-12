/**
 * 新对话空界面品牌：应用图形 + 软件名「Crish」，居中放在项目选择器上方。
 * 图形取自 apps/crish-desktop/public/favicon.svg（app-icon.svg 的无底前景版）：
 * 绿点保持品牌原色，线条走 currentColor 跟随 --text-primary，深浅色都清晰。
 * viewBox 裁到图形外缘（含线帽），svg 高度即图形可见高度，便于与文字等高。
 */
import React from 'react';
import styles from './ChatLandingBrand.module.css';

const MARK_LINES = [
  'M 100 116 L 30 116',
  'M 100 116 L 170 116',
  'M 100 116 L 60 44',
  'M 100 116 L 140 44',
  'M 100 116 L 82 164',
  'M 100 116 L 118 164',
];

export const ChatLandingBrand: React.FC = () => (
  <div className={styles.brand} data-landing-brand="">
    <svg
      className={styles.mark}
      viewBox="17 18 166 159"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse className={styles.markDot} cx="100" cy="34" rx="16" ry="16" />
      <g className={styles.markLines}>
        {MARK_LINES.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
    <span className={styles.name}>Crish</span>
  </div>
);
