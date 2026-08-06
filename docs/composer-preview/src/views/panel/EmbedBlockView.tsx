/**
 * EmbedBlockView — 嵌入块 NodeView (V2)
 *
 * 设计：
 * - 空状态：InlineInput 输入 URL
 * - 渲染态：iframe 容器 + 骨架屏加载 + 底边缘 resize 把手
 * - hover：工具栏浮现（新标签打开、删除）
 */

import React, { useState, useCallback } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Globe, Link2, ExternalLink, Trash2 } from 'lucide-react';
import { InlineInput } from '../../ui/InlineInput';
import { Tooltip } from '../../ui/Tooltip';

export const EmbedBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  deleteNode,
  selected,
}) => {
  const [showInput, setShowInput] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const url = (node.attrs.url as string) || '';
  const height = (node.attrs.height as number) || 400;

  const handleSubmit = useCallback((inputUrl: string) => {
    updateAttributes({ url: inputUrl });
    setShowInput(false);
    setLoaded(false);
  }, [updateAttributes]);

  const handleOpen = useCallback(() => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, [url]);

  return (
    <NodeViewWrapper className={`embed-block-view ${selected ? 'is-selected' : ''}`}>
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
            <div className="block-empty__icon"><Globe size={18} /></div>
            <div className="block-empty__text">
              <span className="block-empty__title">嵌入网页</span>
              <span className="block-empty__hint">粘贴网页、PDF 或在线文档链接</span>
            </div>
          </div>
        )}

        {/* 输入态 */}
        {!url && showInput && (
          <div style={{ padding: '4px 0' }}>
            <InlineInput
              placeholder="粘贴嵌入链接..."
              icon={<Link2 size={14} />}
              onSubmit={handleSubmit}
              onClose={() => setShowInput(false)}
            />
          </div>
        )}

        {/* 渲染态 */}
        {url && (
          <div className="embed-block motion-affordance-host" style={{ height }}>
            {/* 骨架屏 */}
            {!loaded && (
              <div className="embed-block__skeleton">
                <div className="embed-block__skeleton" style={{ position: 'absolute', inset: 0 }}>
                  <span style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)',
                    animation: 'motion-shimmer 1400ms linear infinite',
                  }} />
                </div>
              </div>
            )}

            <iframe
              className="embed-block__frame"
              src={url}
              title="嵌入内容"
              loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-popups"
              onLoad={() => setLoaded(true)}
            />

            {/* Resize 把手 */}
            <div className="embed-block__resizer">
              <div className="embed-block__resizer-grip" />
            </div>

            {/* 工具栏 */}
            <div className="block-shell__toolbar motion-affordance">
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
