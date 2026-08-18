import React from 'react';

interface InlineTagProps {
  name: string;
  isSkill?: boolean;
  onRemove?: () => void;
  onClick?: () => void;
}

export const InlineTag: React.FC<InlineTagProps> = ({ name, isSkill = false, onRemove, onClick }) => {
  const getIconSvg = (tagName: string, skill: boolean): string => {
    if (typeof window !== 'undefined' && (window as any).getFileIconSvg) {
      return (window as any).getFileIconSvg(tagName, skill);
    }
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRemove) {
      onRemove();
    }
  };

  return (
    <span 
      className={`rich-inline-tag ${isSkill ? 'skill-type' : ''}`}
      contentEditable={false}
      onClick={onClick}
    >
      <span 
        className="tag-icon-box" 
        dangerouslySetInnerHTML={{ __html: getIconSvg(name, isSkill) }} 
      />
      <span className="tag-text">{name}</span>
      <span className="tag-remove-btn" title="删除标记" onClick={handleRemove}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </span>
    </span>
  );
};
