import React, { useState } from 'react';
import { Card, Button, Badge, type CardPadding } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons/AppIcon';
import styles from './story.module.css';

const PADDINGS: CardPadding[] = ['none', 'sm', 'md', 'lg'];

export function CardPreview() {
  const [padding, setPadding] = useState<CardPadding>('md');
  const [rim, setRim] = useState(false);
  const [interactive, setInteractive] = useState(true);

  return (
    <div className={styles.storyContainer}>
      <header className={styles.storyHeader}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Card 内容卡片</h1>
        </div>
        <p className={styles.description}>
          承载报告卡、Diff 卡片、文件卡片等容器。严格遵循展示型容器 0
          描边铁律（border:
          none），以表面明度差（--surface-card）建立层级，圆角固化为
          --radius-card (12px)。
        </p>
        <code className={styles.importSnippet}>
          {"import { Card } from '@/components/ui';"}
        </code>
      </header>

      {/* 交互控制台 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>交互控制台 (Knobs)</h2>
        <div className={styles.knobCard}>
          <div className={styles.knobGrid}>
            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Padding</span>
              <select
                className={styles.knobSelect}
                value={padding}
                onChange={(e) => setPadding(e.target.value as CardPadding)}
              >
                {PADDINGS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={rim}
                onChange={(e) => setRim(e.target.checked)}
              />
              Rim 边缘轮廓光
            </label>

            <label className={styles.knobToggle}>
              <input
                type="checkbox"
                checked={interactive}
                onChange={(e) => setInteractive(e.target.checked)}
              />
              Interactive (悬停手势)
            </label>
          </div>

          <div className={styles.liveStage}>
            <div style={{ width: '100%', maxWidth: '420px' }}>
              <Card padding={padding} rim={rim} interactive={interactive}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                      }}
                    >
                      <AppIcon name="blocks" size={16} />
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: '14px',
                          color: 'var(--text-primary)',
                        }}
                      >
                        Agent Execution Unit
                      </span>
                    </div>
                    <Badge tone="accent" dot>
                      Running
                    </Badge>
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: '13px',
                      color: 'var(--text-secondary)',
                      lineHeight: 1.5,
                    }}
                  >
                    正在执行 UI Playground 沙箱环境构建与 HMR 链路联调测试。
                  </p>
                  <div
                    style={{ display: 'flex', gap: '8px', marginTop: '4px' }}
                  >
                    <Button size="xs" variant="secondary">
                      查看日志
                    </Button>
                    <Button size="xs" variant="ghost">
                      取消
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>

      {/* 矩阵 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>内边距档位对比</h2>
        <div className={styles.cardRow}>
          {PADDINGS.map((p) => (
            <Card key={p} padding={p} rim>
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: '13px',
                    color: 'var(--text-primary)',
                  }}
                >
                  Padding: {p}
                </span>
                <span
                  style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}
                >
                  --space-{p === 'none' ? '0' : p} 留白布局
                </span>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
