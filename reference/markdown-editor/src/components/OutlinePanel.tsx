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

/** 面板容器内联样式（主题变量联动，与 FindReplacePanel 同构） */
const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  zIndex: 500,
  width: 232,
  maxHeight: '60%',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 10px',
  background: 'var(--bg-theme)',
  border: '1px solid var(--border-medium)',
  borderRadius: 8,
  boxShadow: '0 4px 16px hsl(80 10% 16% / 0.12)',
  fontSize: 12,
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
};

/** 标题栏：面板名 + 条目计数 + 折叠开关 */
const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  userSelect: 'none',
};

const HEADER_TITLE_STYLE: React.CSSProperties = {
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const HEADER_COUNT_STYLE: React.CSSProperties = {
  flex: 1,
  color: 'var(--text-muted)',
  fontSize: 10,
};

const TOGGLE_STYLE: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  lineHeight: '16px',
  background: 'var(--white)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
};

/** 条目列表容器（面板内部滚动，不触碰引擎滚动容器） */
const LIST_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  overflowY: 'auto',
  minHeight: 0,
};

/** 条目基础样式（缩进/高亮由渲染处叠加） */
const ROW_BASE_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 4px',
  borderRadius: 4,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  color: 'var(--text-primary)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
};

/** 当前章节高亮（主题淡黄，与搜索行同族） */
const ROW_ACTIVE_STYLE: React.CSSProperties = {
  background: 'var(--yellow-tint-2)',
};

/** 级别徽标（弱化显示，视觉区分标题级别） */
const LEVEL_STYLE: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 10,
  flexShrink: 0,
};

/** 空态文案 */
const EMPTY_STYLE: React.CSSProperties = {
  color: 'var(--text-muted)',
  padding: '4px 2px',
  fontSize: 11,
};

/** 条目文本（行内代码字体，超长省略由父级接管） */
const TEXT_STYLE: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const OutlinePanel: React.FC<OutlinePanelProps> = ({
  headings,
  scrollRef,
  resolveScrollLine,
  onJump,
}) => {
  // 面板主体可见态（默认展开；宿主用 outline prop 控制挂载，此为面板
  // 内部收纳开关，不销毁监听）
  const [collapsed, setCollapsed] = useState(false);
  // 当前视口首行（滚动监听 rAF 节流维护；仅变化时 setState）
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
    // 挂载即算一次（初始滚动位置可能非 0）
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
            // 面板按钮必须阻断冒泡：容器 onClick（handleContainerClick）
            // 会把面板点击解析为编辑器光标定位（FindReplacePanel 同款约定）
            e.stopPropagation();
            setCollapsed((c) => !c);
          }}
          aria-label={collapsed ? '展开大纲面板' : '收起大纲面板'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && (
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
                    // 阻断冒泡：大纲点击是导航动作，不得触发容器光标定位
                    // （编辑态光标不动；readOnly 下容器点击本就短路）
                    e.stopPropagation();
                    onJump(entry.line);
                  }}
                  style={{
                    ...ROW_BASE_STYLE,
                    paddingLeft: 4 + (entry.level - 1) * 12,
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
      )}
    </div>
  );
};
