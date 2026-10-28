import React, { useState } from 'react';
import { Input, type InputVariant, type InputSize } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons/AppIcon';
import styles from './story.module.css';

const VARIANTS: InputVariant[] = ['default', 'search', 'password'];
const SIZES: InputSize[] = ['xs', 'sm', 'md', 'lg'];

export function InputPreview() {
  const [variant, setVariant] = useState<InputVariant>('default');
  const [size, setSize] = useState<InputSize>('md');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('工作空间名称');
  const [placeholder, setPlaceholder] = useState('请输入内容...');
  const [hint] = useState('支持字母、数字与下划线');
  const [hasError, setHasError] = useState(false);
  const [clearable, setClearable] = useState(true);
  const [disabled, setDisabled] = useState(false);

  return (
    <div className={styles.storyContainer}>
      <header className={styles.storyHeader}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Input 输入框</h1>
        </div>
        <p className={styles.description}>
          装配 IME 组合输入守卫状态机，落实柔和 Focus Ring（加深混入严格控制在
          3%~10%），支持 search / password 与可清空特性。
        </p>
        <code className={styles.importSnippet}>
          {"import { Input } from '@/components/ui';"}
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
                onChange={(e) => setVariant(e.target.value as InputVariant)}
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
                onChange={(e) => setSize(e.target.value as InputSize)}
              >
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Label</span>
              <input
                className={styles.knobInput}
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>

            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Placeholder</span>
              <input
                className={styles.knobInput}
                type="text"
                value={placeholder}
                onChange={(e) => setPlaceholder(e.target.value)}
              />
            </div>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={clearable}
                onChange={(e) => setClearable(e.target.checked)}
              />
              Clearable
            </label>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={hasError}
                onChange={(e) => setHasError(e.target.checked)}
              />
              Show Error
            </label>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={disabled}
                onChange={(e) => setDisabled(e.target.checked)}
              />
              Disabled
            </label>
          </div>

          <div
            className={styles.liveStage}
            style={{ justifyContent: 'stretch' }}
          >
            <div style={{ width: '100%', maxWidth: '420px', margin: '0 auto' }}>
              <Input
                variant={variant}
                size={size}
                label={label}
                hint={hasError ? undefined : hint}
                error={hasError ? '输入格式有误，请修正后重试' : undefined}
                clearable={clearable}
                disabled={disabled}
                placeholder={placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </div>
        </div>
      </section>

      {/* 变体网格 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>形态与尺寸对比</h2>
        <div className={styles.cardRow}>
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
          >
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--text-tertiary)',
              }}
            >
              默认输入 (Default)
            </span>
            <Input size="sm" placeholder="Small (28px)" />
            <Input size="md" placeholder="Medium (32px)" />
            <Input size="lg" placeholder="Large (40px)" />
          </div>

          <div
            style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
          >
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--text-tertiary)',
              }}
            >
              搜索形态 (Search)
            </span>
            <Input
              variant="search"
              size="sm"
              placeholder="搜索模型或技能..."
              clearable
            />
            <Input
              variant="search"
              size="md"
              placeholder="搜索工作流..."
              clearable
            />
            <Input
              variant="search"
              size="lg"
              placeholder="全局搜索..."
              clearable
            />
          </div>

          <div
            style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
          >
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--text-tertiary)',
              }}
            >
              前缀图标与密码 (Password & Prefix)
            </span>
            <Input variant="password" size="md" placeholder="请输入 API Key" />
            <Input
              size="md"
              prefixIcon={<AppIcon name="bot" size={14} />}
              placeholder="智能助理指令..."
            />
            <Input size="md" disabled value="只读锁定参数值" />
          </div>
        </div>
      </section>
    </div>
  );
}
