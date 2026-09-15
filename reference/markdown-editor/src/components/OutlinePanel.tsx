// ============================================================
// 大纲面板：OutlinePanel.tsx（B3 大纲索引，N2 大纲/标题索引）
// ============================================================
// 职责（薄 UI 壳，业务全在引擎既有设施上接线）：
// - 消费 HeadingIndex 条目数组渲染嵌套大纲（按 level 缩进）；
// - 当前章节高亮：滚动监听（rAF 节流）→ resolveScrollLine（引擎经
//   HeightMap.indexAt 换算视口首行）→ findHeadingSection 二分定位
//   「最后一个位于视口首行之前的标题」；
// - 跳转：点击条目 → onJump（引擎接线：virtualizer.scrollToIndex
//   定位行，与 B2 scrollToMatch 同一设施）。
// - 面板为引擎自带交互组件：默认挂载（MarkdownEngine 根容器内、滚动
//   容器外——不干扰虚拟滚动/行高测量/点击定位），宿主可用 outline
//   prop 关闭；内部可折叠（面板标题栏开关）。
//
// 样式约束：引擎样式域外不允许改动（index.css 禁碰 + css-contract 门禁
// 的 className 引用护栏），面板样式全内联、颜色只走 var(--...) 主题变量。

import React, { useEffect, useMemo, useState } from 'react';
import { ListTree } from 'lucide-react';
import {
  findHeadingSection,
  type HeadingEntry,
} from '../core/headingIndex';

/** 面板 props */
export interface OutlinePanelProps {
  /** 标题条目数组（引擎经 HeadingIndex 增量维护后整体替换引用） */
  headings: readonly HeadingEntry[];
  /** 滚动容器 ref（引擎 parentRef——scroll 事件监听源，不可变约定） */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 滚动位置 → 视口首行（引擎经 HeightMap.indexAt 换算；闭包稳定） */
  resolveScrollLine: (scrollTop: number) => number;
  /** 跳转标题行（引擎接线：virtualizer.scrollToIndex 定位） */
  onJump: (line: number) => void;
}
/** 面板容器内联样式（右上角悬浮，彻底消除对左侧正文与标题的遮挡） */
const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 28,
  zIndex: 'var(--z-panel)',
  width: 240,
  maxHeight: '60%',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 10px',
  background: 'var(--ivory)',
  border: '1px solid var(--border-medium)',
  borderRadius: 8,
  boxShadow: '0 4px 16px hsl(60 10% 10% / 0.12)',
  fontSize: 12,
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-sans)',
};

/** 折叠态紧凑药丸徽标样式（右上角紧凑停靠） */
const COLLAPSED_PILL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 28,
  zIndex: 'var(--z-panel)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  background: 'var(--ivory)',
  border: '1px solid var(--border-medium)',
  borderRadius: 6,
  boxShadow: '0 2px 8px hsl(60 10% 10% / 0.08)',
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--dark-warm)',
  cursor: 'pointer',
  userSelect: 'none',
  transition: 'all 0.15s ease',
};

/** 标题栏：面板名 + 条目计数 + 折叠开关 */
const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  userSelect: 'none',
  paddingBottom: 6,
  borderBottom: '1px solid var(--border-subtle)',
};

const HEADER_TITLE_STYLE: React.CSSProperties = {
  fontWeight: 600,
  color: 'var(--near-black)',
};

const HEADER_COUNT_STYLE: React.CSSProperties = {
  flex: 1,
  color: 'var(--stone)',
  fontSize: 11,
};

const TOGGLE_STYLE: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  lineHeight: '16px',
  background: 'var(--warm-sand)',
  color: 'var(--dark-warm)',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
};

/** 条目列表容器（面板内部滚动，不触碰引擎滚动容器） */
const LIST_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  overflowY: 'auto',
  minHeight: 0,
  maxHeight: 360,
};

/** 条目基础样式（支持自适应折行，杜绝长标题挤叠） */
const ROW_BASE_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  padding: '4px 6px',
  borderRadius: 4,
  cursor: 'pointer',
  width: '100%',
  boxSizing: 'border-box',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  color: 'var(--dark-warm)',
  fontSize: 12,
  lineHeight: '18px',
  fontFamily: 'var(--font-sans)',
  flexShrink: 0,
  minHeight: 22,
};

/** 当前章节高亮 */
const ROW_ACTIVE_STYLE: React.CSSProperties = {
  background: 'var(--tag-standard-bg)',
  color: 'var(--brand)',
  fontWeight: 500,
};

/** 级别徽标 */
const LEVEL_STYLE: React.CSSProperties = {
  color: 'var(--stone)',
  fontSize: 10,
  flexShrink: 0,
  letterSpacing: '0.4px',
  lineHeight: '18px',
};

/** 空态文案 */
const EMPTY_STYLE: React.CSSProperties = {
  color: 'var(--stone)',
  padding: '6px 2px',
  fontSize: 11,
};

/** 条目文本：自动折行，杜绝横向挤压与文字重叠 */
const TEXT_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: 'normal',
  wordBreak: 'break-word',
  lineHeight: '1.4',
};

export const OutlinePanel: React.FC<OutlinePanelProps> = ({
  headings,
  scrollRef,
  resolveScrollLine,
  onJump,
}) => {
  // 默认收起为紧凑小胶囊，绝不遮挡文档任何 H1 标题
  const [collapsed, setCollapsed] = useState(true);
  const [activeLine, setActiveLine] = useState(-1);

  // 滚动监听：rAF 节流换算视口首行 → 当前章节（findHeadingSection 二分）。
  // 引擎滚动管线为 directDomUpdates 命令式模式（滚动位置帧零 React 提交），
  // 当前章节高亮必须自行监听 scroll——这是面板与引擎的唯一运行时耦合点。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const line = resolveScrollLine(el.scrollTop);
      setActiveLine((prev) => (prev === line ? prev : line));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, resolveScrollLine]);

  // 当前章节：视口首行之前最后一个标题（二分）
  const activeSection = useMemo(
    () => (activeLine >= 0 ? findHeadingSection(headings, activeLine) : null),
    [headings, activeLine]
  );

  if (collapsed) {
    return (
      <div
        style={COLLAPSED_PILL_STYLE}
        onClick={(e) => {
          e.stopPropagation();
          setCollapsed(false);
        }}
        title="点击展开大纲面板"
        aria-label="展开大纲面板"
      >
        <span className="outline-chip-icon" aria-hidden="true"><ListTree size={13} /></span>
        <span>大纲</span>
        <span style={{ opacity: 0.7, fontSize: 10 }}>
          {headings.length ? `${headings.length}` : '0'}
        </span>
        <span style={{ fontSize: 9 }}>▸</span>
      </div>
    );
  }

  return (
    <div style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <span style={HEADER_TITLE_STYLE}>大纲</span>
        <span style={HEADER_COUNT_STYLE}>
          {headings.length ? `${headings.length} 项` : ''}
        </span>
        <button
          type="button"
          style={TOGGLE_STYLE}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed(true);
          }}
          aria-label="收起大纲面板"
          title="收起大纲面板"
        >
          ▴
        </button>
      </div>
      <div style={LIST_STYLE}>
        {headings.length === 0 ? (
          <div style={EMPTY_STYLE}>无标题（文档无 ATX 标题）</div>
        ) : (
          headings.map((entry) => {
            const isActive = activeSection?.line === entry.line;
            return (
              <button
                key={entry.line}
                type="button"
                title={entry.text}
                onClick={(e) => {
                  e.stopPropagation();
                  onJump(entry.line);
                }}
                style={{
                  ...ROW_BASE_STYLE,
                  paddingLeft: 4 + (entry.level - 1) * 10,
                  ...(isActive ? ROW_ACTIVE_STYLE : null),
                }}
              >
                <span style={LEVEL_STYLE}>H{entry.level}</span>
                <span style={TEXT_STYLE}>{entry.text}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
