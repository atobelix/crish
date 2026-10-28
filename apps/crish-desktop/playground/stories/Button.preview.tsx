import React, { useState } from 'react';
import {
  Button,
  IconButton,
  type ButtonVariant,
  type ButtonSize,
} from '@/components/ui';
import { AppIcon } from '@/components/ui/icons/AppIcon';
import styles from './story.module.css';

const VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'ghost',
  'danger',
  'plain',
];
const SIZES: ButtonSize[] = ['xs', 'sm', 'md', 'lg'];

export function ButtonPreview() {
  const [variant, setVariant] = useState<ButtonVariant>('primary');
  const [size, setSize] = useState<ButtonSize>('md');
  const [loading, setLoading] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [block, setBlock] = useState(false);
  const [hasIcon, setHasIcon] = useState(false);
  const [iconPosition, setIconPosition] = useState<'left' | 'right'>('left');
  const [buttonText, setButtonText] = useState('操作按钮');

  return (
    <div className={styles.storyContainer}>
      <header className={styles.storyHeader}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Button 按钮</h1>
        </div>
        <p className={styles.description}>
          遵循同心几何标尺与四档标准化尺寸矩阵（24/28/32/40px），原生伪元素
          0-重绘悬浮遮罩与柔和 Focus Ring。
        </p>
        <code className={styles.importSnippet}>
          {"import { Button, IconButton } from '@/components/ui';"}
        </code>
      </header>

      {/* 交互控制台 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>交互控制台 (Knobs)</h2>
        <div className={styles.knobCard}>
          <div className={styles.knobGrid}>
            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Variant</span>
              <select
                className={styles.knobSelect}
                value={variant}
                onChange={(e) => setVariant(e.target.value as ButtonVariant)}
              >
                {VARIANTS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Size</span>
              <select
                className={styles.knobSelect}
                value={size}
                onChange={(e) => setSize(e.target.value as ButtonSize)}
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
                value={buttonText}
                onChange={(e) => setButtonText(e.target.value)}
              />
            </div>

            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Icon Position</span>
              <select
                className={styles.knobSelect}
                value={iconPosition}
                onChange={(e) =>
                  setIconPosition(e.target.value as 'left' | 'right')
                }
              >
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </div>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={loading}
                onChange={(e) => setLoading(e.target.checked)}
              />
              Loading
            </label>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={disabled}
                onChange={(e) => setDisabled(e.target.checked)}
              />
              Disabled
            </label>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={hasIcon}
                onChange={(e) => setHasIcon(e.target.checked)}
              />
              With Icon
            </label>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={block}
                onChange={(e) => setBlock(e.target.checked)}
              />
              Block (100% 宽)
            </label>
          </div>

          <div className={styles.liveStage}>
            <Button
              variant={variant}
              size={size}
              loading={loading}
              disabled={disabled}
              block={block}
              icon={hasIcon ? <AppIcon name="check" size={14} /> : undefined}
              iconPosition={iconPosition}
            >
              {buttonText}
            </Button>
          </div>
        </div>
      </section>

      {/* 变体矩阵 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>尺寸与变体全景矩阵</h2>
        <table className={styles.matrixTable}>
          <thead>
            <tr>
              <th>Variant \ Size</th>
              {SIZES.map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {VARIANTS.map((v) => (
              <tr key={v}>
                <td style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {v}
                </td>
                {SIZES.map((s) => (
                  <td key={s}>
                    <Button variant={v} size={s}>
                      {v} {s}
                    </Button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 状态矩阵 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          交互状态对比 (Default / Loading / Disabled / Icon)
        </h2>
        <div className={styles.matrixGrid}>
          <Button variant="primary">Primary</Button>
          <Button variant="primary" loading>
            Loading
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button variant="primary" icon={<AppIcon name="bot" size={14} />}>
            AI Agent
          </Button>
          <IconButton
            icon={<AppIcon name="copy" size={14} />}
            aria-label="复制内容"
          />
          <IconButton
            icon={<AppIcon name="delete" size={14} />}
            variant="danger"
            aria-label="删除项目"
          />
        </div>
      </section>
    </div>
  );
}
