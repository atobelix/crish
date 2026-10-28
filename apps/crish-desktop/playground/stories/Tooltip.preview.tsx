import React, { useState } from 'react';
import {
  Tooltip,
  Button,
  Badge,
  IconButton,
  type TooltipSide,
} from '@/components/ui';
import { AppIcon } from '@/components/ui/icons/AppIcon';
import styles from './story.module.css';

const SIDES: TooltipSide[] = ['top', 'bottom', 'left', 'right'];

export function TooltipPreview() {
  const [content, setContent] = useState('保存当前工作空间进度');
  const [shortcut, setShortcut] = useState('Ctrl+S');
  const [side, setSide] = useState<TooltipSide>('top');

  return (
    <div className={styles.storyContainer}>
      <header className={styles.storyHeader}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Tooltip 提示气泡</h1>
        </div>
        <p className={styles.description}>
          AGENTS.md §12 强制规范组件：严禁使用原生 HTML
          title。具备全局单槽、delayShow 延迟淡入、页面滚动即灭、与原生 DOM 无缝
          Ref 合并能力。
        </p>
        <code className={styles.importSnippet}>
          {"import { Tooltip } from '@/components/ui';"}
        </code>
      </header>

      {/* 交互控制台 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>交互控制台 (Knobs)</h2>
        <div className={styles.knobCard}>
          <div className={styles.knobGrid}>
            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Content</span>
              <input
                className={styles.knobInput}
                type="text"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>

            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Shortcut</span>
              <input
                className={styles.knobInput}
                type="text"
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
              />
            </div>

            <div className={styles.knobField}>
              <span className={styles.knobLabel}>Side (Preferred)</span>
              <select
                className={styles.knobSelect}
                value={side}
                onChange={(e) => setSide(e.target.value as TooltipSide)}
              >
                {SIDES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.liveStage}>
            <Tooltip
              content={content}
              shortcut={shortcut || undefined}
              side={side}
            >
              <Button variant="primary">悬停体验 Tooltip ({side})</Button>
            </Tooltip>
          </div>
        </div>
      </section>

      {/* 四向避让展示 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>四向定位与快捷键徽章</h2>
        <div
          className={styles.matrixGrid}
          style={{ justifyContent: 'center', padding: '24px 0' }}
        >
          <Tooltip content="顶部提示信息" side="top">
            <Button variant="secondary">Top Side</Button>
          </Tooltip>
          <Tooltip content="底部快捷提示" shortcut="⌘K" side="bottom">
            <Button variant="secondary">Bottom Side</Button>
          </Tooltip>
          <Tooltip content="左侧操作指引" side="left">
            <Button variant="secondary">Left Side</Button>
          </Tooltip>
          <Tooltip content="右侧详情补充" shortcut="F12" side="right">
            <Button variant="secondary">Right Side</Button>
          </Tooltip>
        </div>
      </section>

      {/* 图标与徽章配合 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>各类元素包裹场景</h2>
        <div className={styles.matrixGrid}>
          <Tooltip content="复制选中代码" shortcut="Ctrl+C">
            <IconButton
              icon={<AppIcon name="copy" size={16} />}
              aria-label="复制"
            />
          </Tooltip>
          <Tooltip content="删除此任务分支" shortcut="Del">
            <IconButton
              icon={<AppIcon name="delete" size={16} />}
              variant="danger"
              aria-label="删除"
            />
          </Tooltip>
          <Tooltip content="当前会话运行健康状态：正常">
            <Badge tone="success" dot>
              Health OK
            </Badge>
          </Tooltip>
        </div>
      </section>
    </div>
  );
}
