import React from 'react';
import { AttachedFile } from './types';

interface FileCardProps {
  file: AttachedFile;
  onRemove?: (fileId: string) => void;
  onPreview?: (file: AttachedFile) => void;
}

export const FileCard: React.FC<FileCardProps> = ({ file, onRemove, onPreview }) => {
  const isImage = file.type === 'image' || (file.name && /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(file.name));

  const getIconSvg = (name: string): string => {
    if (typeof window !== 'undefined' && (window as any).getFileIconSvg) {
      return (window as any).getFileIconSvg(name);
    }
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRemove) {
      onRemove(file.id);
    }
  };

  const handlePreview = () => {
    if (onPreview) {
      onPreview(file);
    }
  };

  if (isImage) {
    return (
      <div 
        className="file-card type-image animate-entrance"
        data-file-id={file.id}
        data-file-name={file.name}
        onClick={handlePreview}
      >
        <img 
          src={file.url || 'https://picsum.photos/400/300?random=101'} 
          className="file-thumbnail" 
          alt={file.name} 
        />
        <div className="file-remove" onClick={handleRemove} title="移除附件">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="file-card animate-entrance"
      data-file-id={file.id}
      data-file-name={file.name}
      onClick={handlePreview}
    >
      <div 
        className="file-icon" 
        dangerouslySetInnerHTML={{ __html: getIconSvg(file.name) }} 
      />
      <div className="file-info">
        <div className="file-name">{file.name}</div>
      </div>
      <div className="file-remove" onClick={handleRemove} title="移除附件">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </div>
    </div>
  );
};
