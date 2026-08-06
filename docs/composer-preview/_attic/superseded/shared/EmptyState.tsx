/**
 * EmptyState — 区块空状态占位组件
 *
 * 当区块内容为空时显示的占位 UI。
 * 支持自定义图标、标题和描述文字。
 *
 * 使用示例：
 * ```tsx
 * <EmptyState
 *   icon="Image"
 *   title="添加图片"
 *   description="点击上传或拖拽图片到此处"
 *   onClick={handleUpload}
 * />
 * ```
 */

import React from 'react';

interface EmptyStateProps {
  /** 标题文字 */
  title: string;
  /** 描述文字 */
  description?: string;
  /** Emoji 图标 */
  icon?: string;
  /** 点击回调 */
  onClick?: () => void;
  /** 额外 CSS class */
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon,
  onClick,
  className = '',
}) => {
  return (
    <div
      className={`empty-state ${onClick ? 'empty-state--clickable' : ''} ${className}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {icon && <span className="empty-state__icon">{icon}</span>}
      <span className="empty-state__title">{title}</span>
      {description && (
        <span className="empty-state__description">{description}</span>
      )}
    </div>
  );
};
