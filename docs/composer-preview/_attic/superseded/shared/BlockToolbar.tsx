/**
 * BlockToolbar — 区块通用工具栏壳组件
 *
 * 用于在渲染模式下显示在区块顶部的工具栏（语言选择器、复制按钮等）。
 * 提供统一的布局和样式，各区块只需传入工具栏内容。
 *
 * 使用示例：
 * ```tsx
 * <BlockToolbar>
 *   <BlockToolbar.Left>
 *     <LanguageSelector ... />
 *   </BlockToolbar.Left>
 *   <BlockToolbar.Right>
 *     <CopyButton ... />
 *     <DeleteButton ... />
 *   </BlockToolbar.Right>
 * </BlockToolbar>
 * ```
 */

import React from 'react';

interface BlockToolbarProps {
  children: React.ReactNode;
  className?: string;
}

export const BlockToolbar: React.FC<BlockToolbarProps> & {
  Left: React.FC<{ children: React.ReactNode }>;
  Right: React.FC<{ children: React.ReactNode }>;
} = ({ children, className = '' }) => {
  return (
    <div
      className={`block-toolbar ${className}`}
      contentEditable={false}
    >
      {children}
    </div>
  );
};

const BlockToolbarLeft: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="block-toolbar__left">{children}</div>
);

const BlockToolbarRight: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="block-toolbar__right">{children}</div>
);

BlockToolbar.Left = BlockToolbarLeft;
BlockToolbar.Right = BlockToolbarRight;
