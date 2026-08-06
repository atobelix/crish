import React, { useState, useCallback } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Images, ChevronLeft, ChevronRight, Plus, Trash2, Settings2, Link2 } from 'lucide-react';
import { InlineInput } from '../../ui/InlineInput';
import { Tooltip } from '../../ui/Tooltip';

interface CarouselImage {
  src: string;
  alt: string;
  caption: string;
}

export const CarouselBlockView: React.FC<NodeViewProps> = ({ node, updateAttributes, deleteNode, selected }) => {
  const images = (node.attrs.images as CarouselImage[]) || [];
  const activeIndex = (node.attrs.activeIndex as number) || 0;
  const [showConfig, setShowConfig] = useState(false);
  const [showInput, setShowInput] = useState(false);

  // 切换图片
  const goTo = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(idx, images.length - 1));
    updateAttributes({ activeIndex: clamped });
  }, [images.length, updateAttributes]);

  const prev = useCallback(() => goTo(activeIndex - 1), [activeIndex, goTo]);
  const next = useCallback(() => goTo(activeIndex + 1), [activeIndex, goTo]);

  // 添加图片
  const addImage = useCallback((src: string) => {
    updateAttributes({ images: [...images, { src, alt: '', caption: '' }] });
    setShowInput(false);
  }, [images, updateAttributes]);

  // 删除图片
  const removeImage = useCallback((idx: number) => {
    const next = images.filter((_, i) => i !== idx);
    updateAttributes({
      images: next,
      activeIndex: Math.min(activeIndex, next.length - 1),
    });
  }, [images, activeIndex, updateAttributes]);

  // 空状态
  if (images.length === 0 && !showInput) {
    return (
      <NodeViewWrapper className={`carousel-block-view ${selected ? 'is-selected' : ''}`}>
        <div contentEditable={false}>
          <div className="block-empty motion-fade-in" onClick={() => setShowInput(true)} role="button" tabIndex={0}>
            <div className="block-empty__icon"><Images size={18} /></div>
            <div className="block-empty__text">
              <span className="block-empty__title">添加图片</span>
              <span className="block-empty__hint">上传图片或粘贴链接创建轮播</span>
            </div>
          </div>
        </div>
      </NodeViewWrapper>
    );
  }

  // 输入态
  if (images.length === 0 && showInput) {
    return (
      <NodeViewWrapper className={`carousel-block-view ${selected ? 'is-selected' : ''}`}>
        <div contentEditable={false} style={{ padding: '4px 0' }}>
          <InlineInput
            placeholder="粘贴图片链接..."
            icon={<Link2 size={14} />}
            onSubmit={addImage}
            onClose={() => setShowInput(false)}
          />
        </div>
      </NodeViewWrapper>
    );
  }

  // 渲染态
  return (
    <NodeViewWrapper className={`carousel-block-view ${selected ? 'is-selected' : ''}`}>
      <div className="carousel-block motion-affordance-host" contentEditable={false}>
        {/* 图片容器 */}
        <div className="carousel-block__viewport">
          <img
            className="carousel-block__image"
            src={images[activeIndex]?.src || ''}
            alt={images[activeIndex]?.alt || ''}
            draggable={false}
          />

          {/* 左按钮 */}
          {activeIndex > 0 && (
            <button className="carousel-block__nav carousel-block__nav--prev motion-affordance" onClick={prev} type="button">
              <ChevronLeft size={18} />
            </button>
          )}

          {/* 右按钮 */}
          {activeIndex < images.length - 1 && (
            <button className="carousel-block__nav carousel-block__nav--next motion-affordance" onClick={next} type="button">
              <ChevronRight size={18} />
            </button>
          )}
        </div>

        {/* 圆点指示器 */}
        {images.length > 1 && (
          <div className="carousel-block__dots">
            {images.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`carousel-block__dot ${i === activeIndex ? 'is-active' : ''}`}
                onClick={() => goTo(i)}
                aria-label={`切换到第 ${i + 1} 张图片`}
              />
            ))}
          </div>
        )}

        {/* 右上角工具栏 */}
        <div className="block-shell__toolbar motion-affordance">
          <Tooltip content="图片管理">
            <button type="button" className={`block-shell__action motion-tap ${showConfig ? 'is-active' : ''}`} onClick={() => setShowConfig(v => !v)}>
              <Settings2 size={14} />
            </button>
          </Tooltip>
          <Tooltip content="删除">
            <button type="button" className="block-shell__action is-danger motion-tap" onClick={deleteNode}>
              <Trash2 size={14} />
            </button>
          </Tooltip>
        </div>

        {/* 配置面板 */}
        {showConfig && (
          <div className="carousel-block__config">
            <div className="carousel-block__config-title">图片管理</div>
            <div className="carousel-block__config-list">
              {images.map((img, i) => (
                <div key={i} className="carousel-block__config-item">
                  <img src={img.src} alt="" className="carousel-block__config-thumb" />
                  <span className="carousel-block__config-url">{img.src}</span>
                  <Tooltip content="删除">
                    <button type="button" className="carousel-block__config-delete" onClick={() => removeImage(i)}>
                      <Trash2 size={12} />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
            <button type="button" className="carousel-block__config-add" onClick={() => setShowInput(true)}>
              <Plus size={14} /> 添加图片
            </button>
            {showInput && (
              <div style={{ marginTop: 8 }}>
                <InlineInput
                  placeholder="粘贴图片链接..."
                  icon={<Link2 size={14} />}
                  onSubmit={addImage}
                  onClose={() => setShowInput(false)}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
};
