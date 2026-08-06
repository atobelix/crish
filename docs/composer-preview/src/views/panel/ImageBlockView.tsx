/**
 * ImageBlockView — 图片块 NodeView (V2)
 *
 * 设计原则：
 * - 空状态：统一的灰色虚线框 + 图标，点击弹出 InlineInput 或文件选择器
 * - 渲染态：圆角裁切 + 两侧 resize 手柄 + 可选说明文字
 * - 对齐：支持左/居中/右三种对齐方式
 * - hover：图片微暗 + resize 手柄浮现
 */

import React, { useState, useCallback, useRef } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import {
  ImageIcon, Link2, Trash2, AlignLeft, AlignCenter, AlignRight, Upload,
} from 'lucide-react';
import { InlineInput } from '../../ui/InlineInput';
import { Tooltip } from '../../ui/Tooltip';

/* ────────────────────────────────────────────
 * ImageEmptyState
 * ──────────────────────────────────────────── */

interface ImageEmptyStateProps {
  onClickUrl: () => void;
  onClickUpload: () => void;
}

const ImageEmptyState: React.FC<ImageEmptyStateProps> = ({ onClickUrl, onClickUpload }) => (
  <div className="block-empty motion-fade-in" contentEditable={false}>
    <div className="block-empty__icon">
      <ImageIcon size={18} />
    </div>
    <div className="block-empty__text">
      <span className="block-empty__title">添加图片</span>
      <span className="block-empty__hint">点击上传或粘贴链接</span>
    </div>
    <div className="block-inline-form" style={{ marginTop: 8 }}>
      <button type="button" className="btn btn--secondary btn--sm motion-tap" onClick={onClickUpload}>
        <Upload size={13} /> 上传
      </button>
      <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={onClickUrl}>
        <Link2 size={13} /> 链接
      </button>
    </div>
  </div>
);

/* ────────────────────────────────────────────
 * ImageToolbar — 对齐 + 删除
 * ──────────────────────────────────────────── */

interface ImageToolbarProps {
  align: string;
  onAlign: (a: string) => void;
  onDelete: () => void;
}

const ImageToolbar: React.FC<ImageToolbarProps> = ({ align, onAlign, onDelete }) => (
  <div className="block-shell__toolbar motion-affordance">
    <Tooltip content="左对齐">
      <button
        type="button"
        className={`block-shell__action motion-tap ${align === 'left' ? 'is-active' : ''}`}
        onClick={() => onAlign('left')}
      >
        <AlignLeft size={14} />
      </button>
    </Tooltip>
    <Tooltip content="居中">
      <button
        type="button"
        className={`block-shell__action motion-tap ${align === 'center' ? 'is-active' : ''}`}
        onClick={() => onAlign('center')}
      >
        <AlignCenter size={14} />
      </button>
    </Tooltip>
    <Tooltip content="右对齐">
      <button
        type="button"
        className={`block-shell__action motion-tap ${align === 'right' ? 'is-active' : ''}`}
        onClick={() => onAlign('right')}
      >
        <AlignRight size={14} />
      </button>
    </Tooltip>
    <Tooltip content="删除">
      <button type="button" className="block-shell__action is-danger motion-tap" onClick={onDelete}>
        <Trash2 size={14} />
      </button>
    </Tooltip>
  </div>
);

/* ────────────────────────────────────────────
 * ImageBlockView — 主组件
 * ──────────────────────────────────────────── */

export const ImageBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  deleteNode,
  selected,
}) => {
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [captionEditing, setCaptionEditing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const src = (node.attrs.src as string) || '';
  const alt = (node.attrs.alt as string) || '';
  const caption = (node.attrs.caption as string) || '';
  const align = (node.attrs.align as string) || 'center';
  const width = (node.attrs.width as number) || undefined;

  const handleUrlSubmit = useCallback((url: string) => {
    updateAttributes({ src: url });
    setShowUrlInput(false);
  }, [updateAttributes]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    updateAttributes({ src: url, alt: file.name });
    e.target.value = '';
  }, [updateAttributes]);

  const handleAlign = useCallback((a: string) => {
    updateAttributes({ align: a });
  }, [updateAttributes]);

  const handleCaptionChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateAttributes({ caption: e.target.value });
  }, [updateAttributes]);

  return (
    <NodeViewWrapper
      className={`image-block image-block--${align} motion-affordance-host ${
        selected ? 'is-selected' : ''
      }`}
      style={width ? { width: `${width}px` } : undefined}
    >
      <div contentEditable={false}>
        {!src && !showUrlInput && (
          <>
            <ImageEmptyState
              onClickUrl={() => setShowUrlInput(true)}
              onClickUpload={() => fileInputRef.current?.click()}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={handleFileChange}
            />
          </>
        )}

        {!src && showUrlInput && (
          <div style={{ padding: '4px 0' }}>
            <InlineInput
              placeholder="粘贴图片链接..."
              icon={<Link2 size={14} />}
              onSubmit={handleUrlSubmit}
              onClose={() => setShowUrlInput(false)}
            />
          </div>
        )}

        {src && (
          <>
            <img
              className="image-block__img"
              src={src}
              alt={alt || '图片'}
              draggable={false}
            />
            <div className="image-block__resize-handle image-block__resize-handle--left" />
            <div className="image-block__resize-handle image-block__resize-handle--right" />

            <div
              className="image-block__caption"
              onClick={() => setCaptionEditing(true)}
            >
              {captionEditing ? (
                <input
                  type="text"
                  className="image-block__caption-input"
                  value={caption}
                  onChange={handleCaptionChange}
                  onBlur={() => setCaptionEditing(false)}
                  onKeyDown={(e) => e.key === 'Enter' && setCaptionEditing(false)}
                  placeholder="添加说明..."
                  autoFocus
                />
              ) : (
                <span className={caption ? '' : 'image-block__caption-placeholder'}>
                  {caption || '添加说明'}
                </span>
              )}
            </div>

            <ImageToolbar align={align} onAlign={handleAlign} onDelete={deleteNode} />
          </>
        )}
      </div>
    </NodeViewWrapper>
  );
};
