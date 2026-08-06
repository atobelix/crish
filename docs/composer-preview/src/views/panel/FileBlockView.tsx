/**
 * FileBlockView — 文件附件块 NodeView (V2)
 *
 * 设计：
 * - 空状态：上传/链接双入口
 * - 渲染态：文件卡片（图标 + 文件名 + 大小 + 下载按钮）
 */

import React, { useState, useCallback, useRef } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import {
  Paperclip, Link2, Upload, Download, Trash2,
  FileText, FileImage, FileCode, File,
} from 'lucide-react';
import { InlineInput } from '../../ui/InlineInput';
import { Tooltip } from '../../ui/Tooltip';

/** 根据文件扩展名选择图标 */
function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return FileImage;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'css', 'html'].includes(ext)) return FileCode;
  if (['md', 'txt', 'doc', 'docx', 'pdf'].includes(ext)) return FileText;
  return File;
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FileBlockView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  deleteNode,
  selected,
}) => {
  const [showInput, setShowInput] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const src = (node.attrs.src as string) || '';
  const name = (node.attrs.name as string) || '未命名文件';
  const size = (node.attrs.size as number) || 0;

  const handleUrlSubmit = useCallback((url: string) => {
    const fileName = url.split('/').pop() || '文件';
    updateAttributes({ src: url, name: fileName });
    setShowInput(false);
  }, [updateAttributes]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    updateAttributes({
      src: URL.createObjectURL(file),
      name: file.name,
      size: file.size,
    });
    e.target.value = '';
  }, [updateAttributes]);

  const handleDownload = useCallback(() => {
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = name;
    a.click();
  }, [src, name]);

  const Icon = getFileIcon(name);

  return (
    <NodeViewWrapper className={`file-block-view ${selected ? 'is-selected' : ''}`}>
      <div contentEditable={false}>
        {/* 空状态 */}
        {!src && !showInput && (
          <div className="block-empty motion-fade-in">
            <div className="block-empty__icon"><Paperclip size={18} /></div>
            <div className="block-empty__text">
              <span className="block-empty__title">添加文件</span>
              <span className="block-empty__hint">上传附件或粘贴链接</span>
            </div>
            <div className="block-inline-form" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn--secondary btn--sm motion-tap" onClick={() => fileInputRef.current?.click()}>
                <Upload size={13} /> 上传
              </button>
              <button type="button" className="btn btn--ghost btn--sm motion-tap" onClick={() => setShowInput(true)}>
                <Link2 size={13} /> 链接
              </button>
            </div>
            <input ref={fileInputRef} type="file" hidden onChange={handleFileChange} />
          </div>
        )}

        {/* 输入态 */}
        {!src && showInput && (
          <div style={{ padding: '4px 0' }}>
            <InlineInput
              placeholder="粘贴文件链接..."
              icon={<Link2 size={14} />}
              onSubmit={handleUrlSubmit}
              onClose={() => setShowInput(false)}
            />
          </div>
        )}

        {/* 文件卡片 */}
        {src && (
          <div className="file-block motion-affordance-host">
            <div className="file-block__icon">
              <Icon size={18} />
            </div>
            <div className="file-block__info">
              <div className="file-block__name">{name}</div>
              {size > 0 && <div className="file-block__meta">{formatSize(size)}</div>}
            </div>
            <Tooltip content="下载">
              <button type="button" className="file-block__download motion-tap" onClick={handleDownload}>
                <Download size={16} />
              </button>
            </Tooltip>
            <Tooltip content="删除">
              <button
                type="button"
                className="file-block__download motion-tap"
                style={{ color: 'var(--accent-red)' }}
                onClick={deleteNode}
              >
                <Trash2 size={14} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
};
