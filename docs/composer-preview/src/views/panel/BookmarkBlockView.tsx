/**
 * BookmarkBlockView — 网页书签块 NodeView (V2)
 *
 * 设计：
 * - 空状态：InlineInput 粘贴链接
 * - 渲染态：OG 卡片（标题 + 描述 + favicon + 缩略图）
 * - hover：微提升阴影 + 工具栏浮现
 */

import React, { useState, useCallback } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Bookmark, Link2, ExternalLink, Trash2 } from 'lucide-react';
import { InlineInput } from '../../ui/InlineInput';
import { Tooltip } from '../../ui/Tooltip';

export const BookmarkBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  deleteNode,
  selected,
}) => {
  const [showInput, setShowInput] = useState(false);

  const url = (node.attrs.url as string) || '';
  const title = (node.attrs.title as string) || '';
  const description = (node.attrs.description as string) || '';
  const favicon = (node.attrs.favicon as string) || '';
  const thumbnail = (node.attrs.thumbnail as string) || '';

  const handleSubmit = useCallback((inputUrl: string) => {
    // 简单提取域名作为标题
    let domain = '';
    try { domain = new URL(inputUrl).hostname; } catch { domain = inputUrl; }
    updateAttributes({
      url: inputUrl,
      title: title || domain,
      description: description || inputUrl,
    });
    setShowInput(false);
  }, [title, description, updateAttributes]);

  const handleOpen = useCallback(() => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, [url]);

  return (
    <NodeViewWrapper className={`bookmark-block-view ${selected ? 'is-selected' : ''}`}>
      <div contentEditable={false}>
        {/* 空状态 */}
        {!url && !showInput && (
          <div
            className="block-empty motion-fade-in"
            onClick={() => setShowInput(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setShowInput(true)}
          >
            <div className="block-empty__icon"><Bookmark size={18} /></div>
            <div className="block-empty__text">
              <span className="block-empty__title">添加网页书签</span>
              <span className="block-empty__hint">粘贴 URL 生成预览卡片</span>
            </div>
          </div>
        )}

        {/* 输入态 */}
        {!url && showInput && (
          <div style={{ padding: '4px 0' }}>
            <InlineInput
              placeholder="粘贴网页链接..."
              icon={<Link2 size={14} />}
              onSubmit={handleSubmit}
              onClose={() => setShowInput(false)}
            />
          </div>
        )}

        {/* 渲染态：OG 卡片 */}
        {url && (
          <div className="bookmark-block motion-affordance-host" onClick={handleOpen}>
            <div className="bookmark-block__content">
              <div className="bookmark-block__title">{title || url}</div>
              {description && (
                <div className="bookmark-block__description">{description}</div>
              )}
              <div className="bookmark-block__url">
                {favicon && (
                  <img
                    className="bookmark-block__favicon"
                    src={favicon}
                    alt=""
                    loading="lazy"
                  />
                )}
                <span>{url}</span>
              </div>
            </div>
            {thumbnail && (
              <div className="bookmark-block__thumbnail">
                <img src={thumbnail} alt="" loading="lazy" />
              </div>
            )}

            {/* 悬浮工具栏 */}
            <div
              className="block-shell__toolbar motion-affordance"
              onClick={(e) => e.stopPropagation()}
            >
              <Tooltip content="新标签打开">
                <button type="button" className="block-shell__action motion-tap" onClick={handleOpen}>
                  <ExternalLink size={14} />
                </button>
              </Tooltip>
              <Tooltip content="删除">
                <button type="button" className="block-shell__action is-danger motion-tap" onClick={deleteNode}>
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            </div>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
};
