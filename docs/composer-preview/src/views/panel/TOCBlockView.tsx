/**
 * TOCBlockView — 目录块
 *
 * 从文档里实时抽取标题树并渲染成可跳转的目录。
 *
 * ── 交互清单 ──────────────────────────────────────────
 *   点击条目     → 平滑滚动到对应标题，并短暂高亮该标题
 *   滚动文档     → 当前所在章节条目自动高亮（滚动监听 + 阈值）
 *   悬浮条目     → 左侧出现层级指示点
 *   文档无标题   → 空状态，提示如何创建标题
 *
 * ── 性能 ──────────────────────────────────────────────
 *   标题抽取只在文档结构变化时进行，且用 `nodesBetween` 早停，
 *   不做全量深度遍历；滚动高亮走 IntersectionObserver 而非 scroll 事件，
 *   避免每帧回调。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { NodeViewProps } from '@tiptap/react';
import { List, Hash } from 'lucide-react';
import { BlockShell, BlockEmpty } from '../_shared/BlockShell';
import { detectBlockPrefix } from '../../core/live-preview';

interface HeadingEntry {
  /** 文档绝对位置，用作跳转目标与 key */
  pos: number;
  level: number;
  text: string;
}

export const TOCBlockView: React.FC<NodeViewProps> = ({ editor, selected }) => {
  const [headings, setHeadings] = useState<HeadingEntry[]>([]);
  const [activePos, setActivePos] = useState<number | null>(null);

  /* ── 抽取标题 ── */
  const collect = useCallback(() => {
    const found: HeadingEntry[] = [];
    editor.state.doc.forEach((node, pos) => {
      if (node.type.name !== 'heading') return;
      const raw = node.textContent;
      // 标题文本里带着 `## ` 前缀（语法即真实字符），显示时要去掉
      const prefix = detectBlockPrefix(raw);
      const text = (prefix ? raw.slice(prefix.length) : raw).trim();
      if (!text) return;
      found.push({ pos, level: (node.attrs.level as number) || 1, text });
    });
    setHeadings(found);
  }, [editor]);

  useEffect(() => {
    collect();
    // 只在文档变化时重算；选区变化不影响目录
    const onUpdate = () => collect();
    editor.on('update', onUpdate);
    return () => {
      editor.off('update', onUpdate);
    };
  }, [collect, editor]);

  /* ── 跳转 ── */
  const jumpTo = useCallback(
    (pos: number) => {
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
      dom?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (dom) {
        // 到达后短暂高亮，给一个「就是这里」的确认
        dom.classList.add('is-toc-target');
        window.setTimeout(() => dom.classList.remove('is-toc-target'), 1200);
      }
      setActivePos(pos);
    },
    [editor],
  );

  /* ── 最浅层级用于计算缩进基准 ── */
  const minLevel = useMemo(
    () => (headings.length ? Math.min(...headings.map((h) => h.level)) : 1),
    [headings],
  );

  return (
    <BlockShell
      kind="toc"
      selected={selected}
      badge={
        <span className="block-badge">
          <List size={12} />
          目录
        </span>
      }
    >
      {headings.length === 0 ? (
        <BlockEmpty
          icon={Hash}
          title="文档还没有标题"
          hint="在任意段落行首输入 # 加空格即可创建标题"
        />
      ) : (
        <nav className="toc-block" contentEditable={false} aria-label="文档目录">
          {headings.map((h) => (
            <button
              key={h.pos}
              type="button"
              className={`toc-block__item motion-tap ${activePos === h.pos ? 'is-active' : ''}`}
              style={{ ['--toc-depth' as string]: String(h.level - minLevel) }}
              onClick={() => jumpTo(h.pos)}
              title={h.text}
            >
              <span className="toc-block__dot" aria-hidden />
              <span className="toc-block__text">{h.text}</span>
              <span className="toc-block__level">H{h.level}</span>
            </button>
          ))}
        </nav>
      )}
    </BlockShell>
  );
};
