/**
 * FenceMarker — 统一围栏标记组件
 *
 * 用于 L2 围栏块（代码块、Mermaid、Diff、KaTeX、Callout）的
 * 开始/结束标记渲染。
 *
 * 与旧版的关键区别：
 * - 不使用 contentEditable — 使用普通 <input> 或 <span>
 * - 修改围栏文本通过回调触发 updateAttributes()，参与 Undo/Redo
 * - 所有样式通过 CSS class 管理，零内联样式
 *
 * 使用示例：
 * ```tsx
 * // 可编辑的围栏开始标记（用于修改语言名）
 * <FenceMarker
 *   text={`\`\`\`${language}`}
 *   position="top"
 *   editable
 *   onTextChange={(newText) => {
 *     const match = newText.match(/^`{3,}\s*([\w-]*)$/);
 *     if (match) updateAttributes({ language: match[1] || 'plaintext' });
 *   }}
 *   onEnter={() => focusContent()}
 * />
 *
 * // 只读的围栏结束标记
 * <FenceMarker text="```" position="bottom" />
 * ```
 */

import React, { useCallback, useRef } from 'react';

export interface FenceMarkerProps {
  /** 显示的标记文本，如 "```javascript"、"$$"、"```" */
  text: string;

  /** 标记位置：顶部（围栏开始）或底部（围栏结束） */
  position: 'top' | 'bottom';

  /** 是否可编辑。可编辑时渲染 <input>，否则渲染 <span> */
  editable?: boolean;

  /** 文本变更回调（仅 editable=true 时生效） */
  onTextChange?: (newText: string) => void;

  /** 按下 Enter 键的回调（通常用于将焦点移入代码内容区域） */
  onEnter?: () => void;

  /** 按下 Escape 键的回调（通常用于退出编辑模式） */
  onEscape?: () => void;

  /** 额外的 CSS class */
  className?: string;
}

export const FenceMarker: React.FC<FenceMarkerProps> = ({
  text,
  position,
  editable = false,
  onTextChange,
  onEnter,
  onEscape,
  className = '',
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onEnter?.();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onEscape?.();
      }
    },
    [onEnter, onEscape],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onTextChange?.(e.target.value);
    },
    [onTextChange],
  );

  const positionClass = `fence-marker--${position}`;

  if (editable && onTextChange) {
    return (
      <div
        className={`fence-marker ${positionClass} ${className}`}
        contentEditable={false}
      >
        <input
          ref={inputRef}
          className="fence-marker__input"
          type="text"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    );
  }

  // 只读标记
  return (
    <div
      className={`fence-marker ${positionClass} ${className}`}
      contentEditable={false}
    >
      <span className="fence-marker__text">{text}</span>
    </div>
  );
};
