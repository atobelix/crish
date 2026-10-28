import React, { useState } from 'react';
import { Badge, type StandardBadgeTone, type BadgeSize } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons/AppIcon';
import styles from './story.module.css';

const TONES: StandardBadgeTone[] = [
  'neutral',
  'accent',
  'warning',
  'danger',
  'success',
];
const SIZES: BadgeSize[] = ['xs', 'sm', 'md'];

export function BadgePreview() {
  const [tone, setTone] = useState<StandardBadgeTone>('accent');
  const [size, setSize] = useState<BadgeSize>('sm');
  const [dot, setDot] = useState(true);
  const [removable, setRemovable] = useState(false);
  const [text, setText] = useState('Active');

  return (
    <div className={styles.storyContainer}>
      <header className={styles.storyHeader}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Badge 徽标 / 标签</h1>
        </div>
        <p className={styles.description}>
          遵循展示型容器 0 描边铁律（border: none），采用角色圆角 --radius-row
          (6px)，提供 neutral / accent / warning / danger / success 5 类受限语义
          tone。
        </p>
        <code className={styles.importSnippet}>
          {"import { Badge } from '@/components/ui';"}
        </code>
      </header>

      {/* 交互控制台 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>交互控制台 (Knobs)</h2>
        <div className={styles.knobCard}>
          <div className={styles.knobGrid}>
            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Tone</span>
              <select
                className={styles.knobSelect}
                value={tone}
                onChange={(e) => setTone(e.target.value as StandardBadgeTone)}
              >
                {TONES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Size</span>
              <select
                className={styles.knobSelect}
                value={size}
                onChange={(e) => setSize(e.target.value as BadgeSize)}
              >
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Text</span>
              <input
                className={styles.knobInput}
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={dot}
                onChange={(e) => setDot(e.target.checked)}
              />
              Dot 状态圆点
            </label>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={removable}
                onChange={(e) => setRemovable(e.target.checked)}
              />
              Removable (Chip 模式)
            </label>
          </div>

          <div className={styles.liveStage}>
            <Badge
              tone={tone}
              size={size}
              dot={dot}
              onRemove={removable ? () => alert('Remove clicked') : undefined}
            >
              {text}
            </Badge>
          </div>
        </div>
      </section>

      {/* 变体矩阵 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>语义色调与尺寸全景矩阵</h2>
        <table className={styles.matrixTable}>
          <thead>
            <tr>
              <th>Tone \ Size</th>
              {SIZES.map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TONES.map((t) => (
              <tr key={t}>
                <td style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {t}
                </td>
                {SIZES.map((s) => (
                  <td key={s}>
                    <Badge tone={t} size={s} dot>
                      {t}
                    </Badge>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 复合应用 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>图标与可移除 Tag (Chip)</h2>
        <div className={styles.matrixGrid}>
          <Badge tone="accent" icon={<AppIcon name="bot" size={12} />}>
            Claude 3.5 Sonnet
          </Badge>
          <Badge tone="neutral" icon={<AppIcon name="code" size={12} />}>
            TypeScript
          </Badge>
          <Badge tone="warning" onRemove={() => {}} removeAriaLabel="移除标签">
            Draft Filter
          </Badge>
          <Badge tone="success" dot>
            Online
          </Badge>
          <Badge tone="danger" dot>
            Offline
          </Badge>
        </div>
      </section>
    </div>
  );
}
