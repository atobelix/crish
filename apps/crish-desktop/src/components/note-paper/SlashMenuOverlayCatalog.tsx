/**
 * SlashMenuOverlay 目录区渲染（SD-13）
 *
 * 只读 banner / 空过滤 / group + item 按钮。
 * 皮：`.bp-slash-*`（`@crish/block-paper/chrome.css`）。
 *
 * **≠ EL-01**；呈现切开 ≠ slash 产品 e2e。
 */

import React from 'react';
import {
  BP_SLASH_EMPTY,
  BP_SLASH_GROUP,
  BP_SLASH_ITEM,
  type SlashCatalogSegment,
  type SlashMenuItemView,
  type SlashMenuModel,
} from '@crish/block-paper';

export type SlashMenuOverlayCatalogProps = {
  testId: string;
  isReadOnly: boolean;
  pending: boolean;
  emptyMessage: string;
  readOnlyMessage: string;
  /** 过滤后的扁平 items（用于 activeIndex） */
  items: readonly SlashMenuItemView[];
  activeIndex: number;
  segments: readonly SlashCatalogSegment<SlashMenuItemView>[];
  menu: SlashMenuModel;
  onSelectItem: (catalogItemId: string) => void;
};

/**
 * 浮层内部：readonly banner + empty 或 group/item 列表。
 */
export const SlashMenuOverlayCatalog: React.FC<
  SlashMenuOverlayCatalogProps
> = ({
  testId,
  isReadOnly,
  pending,
  emptyMessage,
  readOnlyMessage,
  items,
  activeIndex,
  segments,
  menu,
  onSelectItem,
}) => {
  let flatIndex = 0;

  return (
    <>
      {isReadOnly ? (
        <div
          className="bp-slash-empty"
          data-testid={`${testId}-readonly-banner`}
          data-slash-readonly="1"
          role="status"
        >
          {readOnlyMessage}
        </div>
      ) : null}
      {items.length === 0 ? (
        <div
          className="bp-slash-empty"
          {...{ [BP_SLASH_EMPTY]: '1' }}
          role="status"
        >
          {emptyMessage}
        </div>
      ) : (
        segments.map((seg, segIdx) => (
          <React.Fragment key={`seg-${seg.group ?? 'ungrouped'}-${segIdx}`}>
            {seg.group ? (
              <div
                className="bp-slash-group-label"
                {...{ [BP_SLASH_GROUP]: seg.group }}
                role="presentation"
              >
                {seg.group}
              </div>
            ) : null}
            {seg.items.map((it) => {
              const idx = flatIndex;
              flatIndex += 1;
              const isActive = idx === activeIndex;
              const optionId = `np-slash-opt-${it.id}`;
              const itemDisabled = pending || isReadOnly;
              return (
                <button
                  key={it.id}
                  type="button"
                  id={optionId}
                  className="bp-slash-item"
                  {...{ [BP_SLASH_ITEM]: '1' }}
                  data-item-id={it.id}
                  data-active={isActive ? '1' : '0'}
                  data-slash-item-disabled={itemDisabled ? '1' : '0'}
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={itemDisabled ? true : undefined}
                  tabIndex={-1}
                  disabled={itemDisabled}
                  onMouseEnter={() => {
                    if (isReadOnly) return;
                    // 对齐键盘 active：把高亮移到悬停项（moveActive 会 emit）
                    const delta = idx - menu.getSnapshot().activeIndex;
                    if (delta !== 0) {
                      menu.moveActive(delta);
                    }
                  }}
                  onClick={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    onSelectItem(it.id);
                  }}
                >
                  <span className="bp-slash-item-icon" aria-hidden>
                    {(it.title.trim().charAt(0) || '?').toUpperCase()}
                  </span>
                  <span className="bp-slash-item-body">
                    <span className="bp-slash-item-title">{it.title}</span>
                    {it.description ? (
                      <span className="bp-slash-item-desc">
                        {it.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </React.Fragment>
        ))
      )}
    </>
  );
};

export default SlashMenuOverlayCatalog;
