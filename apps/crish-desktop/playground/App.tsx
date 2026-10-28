import React, { useState, useEffect, useMemo } from 'react';
import styles from './Playground.module.css';

import { ButtonPreview } from './stories/Button.preview';
import { InputPreview } from './stories/Input.preview';
import { CardPreview } from './stories/Card.preview';
import { BadgePreview } from './stories/Badge.preview';
import { TooltipPreview } from './stories/Tooltip.preview';
import { SwitchPreview } from './stories/Switch.preview';
import { DialogPreview } from './stories/Dialog.preview';

interface ComponentItem {
  id: string;
  name: string;
  category: 'Actions' | 'Forms' | 'Surfaces' | 'Feedback' | 'Overlays';
  component: React.ComponentType;
  tag: string;
}

const COMPONENTS: ComponentItem[] = [
  {
    id: 'button',
    name: 'Button 按钮',
    category: 'Actions',
    component: ButtonPreview,
    tag: 'PE-05',
  },
  {
    id: 'input',
    name: 'Input 输入框',
    category: 'Forms',
    component: InputPreview,
    tag: 'PE-05',
  },
  {
    id: 'card',
    name: 'Card 卡片',
    category: 'Surfaces',
    component: CardPreview,
    tag: 'P4-02',
  },
  {
    id: 'badge',
    name: 'Badge 徽标',
    category: 'Feedback',
    component: BadgePreview,
    tag: 'P4-03',
  },
  {
    id: 'tooltip',
    name: 'Tooltip 提示气泡',
    category: 'Overlays',
    component: TooltipPreview,
    tag: 'I2',
  },
  {
    id: 'switch',
    name: 'Switch 开关',
    category: 'Forms',
    component: SwitchPreview,
    tag: 'PE-05',
  },
  {
    id: 'dialog',
    name: 'Dialog 对话框',
    category: 'Overlays',
    component: DialogPreview,
    tag: '04-detail',
  },
];

export function App() {
  const [selectedId, setSelectedId] = useState('button');
  const [search, setSearch] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [density, setDensity] = useState<'default' | 'compact'>('default');
  const [stageSurface, setStageSurface] = useState<
    'canvas' | 'card' | 'sunken'
  >('canvas');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-density', density);
  }, [theme, density]);

  const filteredComponents = useMemo(() => {
    if (!search.trim()) return COMPONENTS;
    const q = search.toLowerCase();
    return COMPONENTS.filter(
      (c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
    );
  }, [search]);

  const currentItem =
    COMPONENTS.find((c) => c.id === selectedId) ?? COMPONENTS[0];
  const CurrentStory = currentItem.component;

  const surfaceBg =
    stageSurface === 'canvas'
      ? 'var(--surface-canvas)'
      : stageSurface === 'card'
        ? 'var(--surface-card)'
        : 'var(--surface-sunken)';

  return (
    <div className={styles.playgroundRoot}>
      {/* 侧边导航栏 */}
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <h2 className={styles.brandTitle}>
            <span>⚡</span>
            <span>Conex UI Playground</span>
          </h2>
          <span className={styles.brandBadge}>Zero-Bundle Sandbox :5174</span>
        </div>

        <div className={styles.searchWrapper}>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="搜索原子组件..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <nav className={styles.navList}>
          {filteredComponents.map((c) => (
            <button
              key={c.id}
              className={`${styles.navItem} ${selectedId === c.id ? styles.active : ''}`}
              onClick={() => setSelectedId(c.id)}
            >
              <span>{c.name}</span>
              <span className={styles.navTag}>{c.tag}</span>
            </button>
          ))}
          {filteredComponents.length === 0 && (
            <div
              style={{
                padding: '16px 12px',
                fontSize: '12px',
                color: 'var(--text-tertiary)',
              }}
            >
              未匹配到组件
            </div>
          )}
        </nav>

        <footer className={styles.sidebarFooter}>
          <span>{COMPONENTS.length} Primitives</span>
          <span>HMR Instant</span>
        </footer>
      </aside>

      {/* 主展示区 */}
      <main className={styles.mainCanvas}>
        <header className={styles.topToolbar}>
          <div className={styles.toolbarLeft}>
            <span className={styles.breadcrumb}>
              Components / <strong>{currentItem.name}</strong>
            </span>
          </div>

          <div className={styles.toolbarControls}>
            <button
              className={styles.toolBtn}
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              title="切换色彩主题"
            >
              {theme === 'dark' ? '🌙 深色主题' : '☀️ 浅色主题'}
            </button>

            <button
              className={styles.toolBtn}
              onClick={() =>
                setDensity((d) => (d === 'default' ? 'compact' : 'default'))
              }
              title="切换几何密度"
            >
              密度: {density === 'default' ? '标准' : '紧凑'}
            </button>

            <button
              className={styles.toolBtn}
              onClick={() =>
                setStageSurface((s) =>
                  s === 'canvas' ? 'card' : s === 'card' ? 'sunken' : 'canvas'
                )
              }
              title="切换底板表面层级以测试对比度"
            >
              底板: {stageSurface}
            </button>
          </div>
        </header>

        <section className={styles.stage} style={{ background: surfaceBg }}>
          <div className={styles.stageInner}>
            <CurrentStory />
          </div>
        </section>
      </main>
    </div>
  );
}
