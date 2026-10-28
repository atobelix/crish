import React, { useState } from 'react';
import { Switch, type SwitchSize } from '@/components/ui';
import styles from './story.module.css';

const SIZES: SwitchSize[] = ['sm', 'md', 'lg'];

export function SwitchPreview() {
  const [checked, setChecked] = useState(true);
  const [size, setSize] = useState<SwitchSize>('md');
  const [loading, setLoading] = useState(false);
  const [disabled, setDisabled] = useState(false);

  return (
    <div className={styles.storyContainer}>
      <header className={styles.storyHeader}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Switch 开关</h1>
        </div>
        <p className={styles.description}>
          现代化自研开关组件：0ms 乐观响应状态机、GPU 硬件垂直中轴定位、0 0 0
          0.5px 发丝微收边，并严格落实 AGENTS.md §13 焦点环规范。
        </p>
        <code className={styles.importSnippet}>
          {"import { Switch } from '@/components/ui';"}
        </code>
      </header>

      {/* 交互控制台 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>交互控制台 (Knobs)</h2>
        <div className={styles.knobCard}>
          <div className={styles.knobGrid}>
            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Size</span>
              <select
                className={styles.knobSelect}
                value={size}
                onChange={(e) => setSize(e.target.value as SwitchSize)}
              >
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              Checked (开/关)
            </label>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={loading}
                onChange={(e) => setLoading(e.target.checked)}
              />
              Loading 锁定态
            </label>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={disabled}
                onChange={(e) => setDisabled(e.target.checked)}
              />
              Disabled 禁用态
            </label>
          </div>

          <div className={styles.liveStage}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Switch
                checked={checked}
                onCheckedChange={setChecked}
                size={size}
                loading={loading}
                disabled={disabled}
                aria-label="Playground 开关实例"
              />
              <span
                style={{ fontSize: '13px', color: 'var(--text-secondary)' }}
              >
                {checked ? '启用状态 (ON)' : '已关闭 (OFF)'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 矩阵 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>全尺寸与状态对比</h2>
        <table className={styles.matrixTable}>
          <thead>
            <tr>
              <th>Size</th>
              <th>Checked (开)</th>
              <th>Unchecked (关)</th>
              <th>Loading (加载态)</th>
              <th>Disabled (禁用态)</th>
            </tr>
          </thead>
          <tbody>
            {SIZES.map((s) => (
              <tr key={s}>
                <td style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {s}
                </td>
                <td>
                  <Switch
                    size={s}
                    defaultChecked
                    aria-label={`Switch ${s} Checked`}
                  />
                </td>
                <td>
                  <Switch
                    size={s}
                    defaultChecked={false}
                    aria-label={`Switch ${s} Unchecked`}
                  />
                </td>
                <td>
                  <Switch
                    size={s}
                    defaultChecked
                    loading
                    aria-label={`Switch ${s} Loading`}
                  />
                </td>
                <td>
                  <Switch
                    size={s}
                    defaultChecked
                    disabled
                    aria-label={`Switch ${s} Disabled`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
