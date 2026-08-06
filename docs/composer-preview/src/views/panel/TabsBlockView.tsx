/**
 * TabsBlockView — 选项卡
 *
 * ── 交互清单 ──────────────────────────────────────────
 *   点击标签       → 切换面板
 *   双击标签       → 就地重命名（输入框继承标签样式，无跳变）
 *   悬浮标签       → 出现关闭按钮（仅在多于 1 个 Tab 时）
 *   标签栏末尾 +   → 新增 Tab 并自动切过去、进入重命名态
 *   ← → 方向键     → 在标签间移动焦点（roving tabindex）
 *   Home / End     → 跳到首尾标签
 *   活动指示条     → 用 transform 在标签间滑动，而非重绘边框
 *
 * 活动指示条是这个组件里唯一「值得做动画」的地方：
 * 它给切换一个连续的空间轨迹，让用户知道自己从哪来、到哪去。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeViewContent } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Layers, Plus, X } from 'lucide-react';
import { BlockShell } from '../_shared/BlockShell';

interface TabMeta {
  id: string;
  label: string;
}

export const TabsBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  selected,
  editor,
  getPos,
}) => {
  /**
   * 面板元信息。
   *
   * 必须 memo：下面几个 useCallback 都依赖 tabs，
   * 若每次渲染都产生新数组，回调会跟着重建，
   * 进而让所有子按钮的 props 变化、白白重渲染整个标签栏。
   * 依赖取 node.content 而非 node——只有子节点真正变化时才重算。
   */
  const tabs: TabMeta[] = useMemo(() => {
    const list: TabMeta[] = [];
    node.forEach((child) => {
      list.push({
        id: (child.attrs.tabId as string) || '',
        label: (child.attrs.label as string) || 'Tab',
      });
    });
    return list;
  }, [node.content]);

  const activeId = (node.attrs.activeTabId as string) || tabs[0]?.id
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeId));

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  /* ── 活动指示条：测量目标标签的位置并用 transform 平移 ── */
  useEffect(() => {
    const list = listRef.current;
    const indicator = indicatorRef.current;
    if (!list || !indicator) return;
    const target = list.children[activeIndex] as HTMLElement | undefined;
    if (!target) return;
    indicator.style.transform = `translate3d(${target.offsetLeft}px, 0, 0)`;
    indicator.style.width = `${target.offsetWidth}px`;
  }, [activeIndex, tabs.length, renamingId]);

  const selectTab = useCallback(
    (id: string) => updateAttributes({ activeTabId: id }),
    [updateAttributes],
  );

  /* ── 重命名 ── */
  const beginRename = useCallback((tab: TabMeta) => {
    setRenamingId(tab.id);
    setDraftLabel(tab.label);
  }, []);

  const commitRename = useCallback(() => {
    if (!renamingId || typeof getPos !== 'function') {
      setRenamingId(null);
      return;
    }
    const basePos = getPos();
    if (basePos === undefined) {
      setRenamingId(null);
      return;
    }

    const label = draftLabel.trim() || 'Tab';
    let offset = basePos + 1;
    const tr = editor.state.tr;
    node.forEach((child) => {
      if (child.attrs.tabId === renamingId) {
        tr.setNodeMarkup(offset, undefined, { ...child.attrs, label });
      }
      offset += child.nodeSize;
    });
    editor.view.dispatch(tr);
    setRenamingId(null);
  }, [draftLabel, editor, getPos, node, renamingId]);

  /* ── 增删 Tab ── */
  const addTab = useCallback(() => {
    if (typeof getPos !== 'function') return;
    const pos = getPos();
    if (pos === undefined) return;

    const panelType = editor.schema.nodes.tabPanel;
    const paragraph = editor.schema.nodes.paragraph;
    if (!panelType || !paragraph) return;

    const id = `tab-${Date.now().toString(36)}`;
    const tr = editor.state.tr;
    tr.insert(
      pos + node.nodeSize - 1,
      panelType.create({ tabId: id, label: `Tab ${tabs.length + 1}` }, paragraph.create()),
    );
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, activeTabId: id });
    editor.view.dispatch(tr);
  }, [editor, getPos, node, tabs.length]);

  const removeTab = useCallback(
    (id: string) => {
      if (tabs.length <= 1 || typeof getPos !== 'function') return;
      const basePos = getPos();
      if (basePos === undefined) return;

      // 先扫出待删面板的范围。用 -1 而不是 null 作哨兵，
      // 避免 TS 把闭包内的赋值判定为不可达而将类型收窄成 never。
      let removeFrom = -1;
      let removeTo = -1;
      let offset = basePos + 1;
      node.forEach((child) => {
        if (child.attrs.tabId === id) {
          removeFrom = offset;
          removeTo = offset + child.nodeSize;
        }
        offset += child.nodeSize;
      });
      if (removeFrom < 0) return;

      const fallback = tabs.find((t) => t.id !== id)?.id ?? '';
      const tr = editor.state.tr.delete(removeFrom, removeTo);
      tr.setNodeMarkup(basePos, undefined, { ...node.attrs, activeTabId: fallback });
      editor.view.dispatch(tr);
    },
    [editor, getPos, node, tabs],
  );

  /* ── 键盘导航 ── */
  const onTabKeyDown = useCallback(
    (event: React.KeyboardEvent, index: number) => {
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;

      event.preventDefault();
      selectTab(tabs[nextIndex].id);
      (listRef.current?.children[nextIndex] as HTMLElement | undefined)?.focus();
    },
    [selectTab, tabs],
  );

  return (
    <BlockShell
      kind="tabs"
      selected={selected}
      badge={
        <span className="block-badge">
          <Layers size={12} />
          选项卡
        </span>
      }
    >
      <div className="tabs-block" data-active-index={activeIndex}>
        {/* 标签栏 */}
        <div className="tabs-block__bar" contentEditable={false}>
          <div ref={listRef} className="tabs-block__list" role="tablist">
            {tabs.map((tab, index) => (
              <div
                key={tab.id}
                role="tab"
                tabIndex={index === activeIndex ? 0 : -1}
                aria-selected={index === activeIndex}
                className={`tabs-block__tab motion-tap motion-affordance-host ${
                  index === activeIndex ? 'is-active' : ''
                }`}
                onClick={() => selectTab(tab.id)}
                onDoubleClick={() => beginRename(tab)}
                onKeyDown={(e) => onTabKeyDown(e, index)}
              >
                {renamingId === tab.id ? (
                  <input
                    className="tabs-block__rename"
                    value={draftLabel}
                    autoFocus
                    onChange={(e) => setDraftLabel(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                ) : (
                  <>
                    <span className="tabs-block__label">{tab.label}</span>
                    {tabs.length > 1 && (
                      <button
                        type="button"
                        className="tabs-block__close motion-affordance"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTab(tab.id);
                        }}
                        aria-label={`删除 ${tab.label}`}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
            <div ref={indicatorRef} className="tabs-block__indicator" aria-hidden />
          </div>

          <button
            type="button"
            className="tabs-block__add motion-tap"
            onClick={addTab}
            aria-label="新增选项卡"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* 面板内容：非活动面板用 CSS 隐藏，保持 ProseMirror 文档完整 */}
        <NodeViewContent className="tabs-block__panels" />
      </div>
    </BlockShell>
  );
};
