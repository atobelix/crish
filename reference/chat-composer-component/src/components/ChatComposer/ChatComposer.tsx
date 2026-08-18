import React, { useState, useRef, useEffect } from 'react';
import { ChatComposerProps, AttachedFile } from './types';
import { FileCard } from './FileCard';

export const ChatComposer: React.FC<ChatComposerProps> = ({
  files = [],
  placeholder = '输入 / 或顿号 、 呼出命令，@ 引用文件，@@ 唤起目录树...',
  permissionLabel = '完全访问',
  modelName = '5.5 超高',
  disabled = false,
  onSend,
  onFileAdd,
  onFileRemove,
  onFilePreview,
}) => {
  const [fileList, setFileList] = useState<AttachedFile[]>(files);
  const [inputText, setInputText] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const editableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFileList(files);
  }, [files]);

  const hasContent = (editableRef.current?.innerText.trim().length || 0) > 0 || fileList.length > 0;

  const handleSend = () => {
    if (!hasContent || disabled) return;
    const content = editableRef.current?.innerText.trim() || '';
    if (onSend) {
      onSend(content, fileList);
    }
  };

  const handleFileRemove = (fileId: string) => {
    setFileList((prev) => prev.filter((f) => f.id !== fileId));
    if (onFileRemove) {
      onFileRemove(fileId);
    }
  };

  return (
    <div className={`composer-container ${isDragOver ? 'drag-over' : ''}`}>
      {/* Top Layer: File Attachment Zone */}
      <div className="file-zone">
        {fileList.map((file) => (
          <FileCard 
            key={file.id} 
            file={file} 
            onRemove={handleFileRemove} 
            onPreview={onFilePreview} 
          />
        ))}
      </div>

      {/* Lower Layer: Rich Contenteditable Input Area */}
      <div className="input-zone">
        <div
          ref={editableRef}
          className="composer-editable"
          contentEditable={!disabled}
          data-placeholder={placeholder}
          onInput={() => setInputText(editableRef.current?.innerText || '')}
        />
      </div>

      {/* Bottom Action Bar */}
      <div className="action-bar">
        <div className="action-left">
          <button className="icon-btn-plus" title="添加附件或 Skill" disabled={disabled}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <div className="action-pill-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>{permissionLabel}</span>
          </div>
        </div>

        <div className="action-right">
          <div className="action-pill-btn">
            <circle cx="12" cy="12" r="10" />
            <span>{modelName}</span>
          </div>
          <button
            className={`btn-send ${hasContent ? 'active' : ''}`}
            onClick={handleSend}
            disabled={!hasContent || disabled}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};
