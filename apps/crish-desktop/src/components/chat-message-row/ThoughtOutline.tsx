import React from 'react';
import type { ThoughtHeading } from '../../workers/thoughtWorker';
import styles from './ThoughtOutline.module.css';

export interface ThoughtOutlineProps {
  headings: ThoughtHeading[];
  onSelectHeading: (heading: ThoughtHeading) => void;
  activeHeadingId?: string | null;
}

export const ThoughtOutline: React.FC<ThoughtOutlineProps> = ({
  headings,
  onSelectHeading,
  activeHeadingId,
}) => {
  if (!headings.length) return null;

  return (
    <nav className={styles.outlineNav} aria-label="思考目录大纲">
      <div className={styles.outlineTitle}>大纲导航 ({headings.length})</div>
      <ul className={styles.headingList}>
        {headings.map((h) => (
          <li
            key={h.id}
            className={`${styles.headingItem} ${styles[`level-${h.level}`] || ''} ${
              activeHeadingId === h.id ? styles.active : ''
            }`}
          >
            <button
              type="button"
              className={styles.headingBtn}
              onClick={() => onSelectHeading(h)}
              title={h.text}
            >
              <span className={styles.headingDot} />
              <span className={styles.headingText}>{h.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};
