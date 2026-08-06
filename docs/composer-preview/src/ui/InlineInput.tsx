/**
 * InlineInput — 通用跟随式输入组件
 *
 * 设计原则（参考截图中提炼）：
 * - 不内嵌在面板中，而是从锚点位置浮出
 * - 无按钮——Enter 提交，Escape 取消
 * - 粘贴时自动检测 URL 并立即提交
 * - 使用 motion-rise-in 动画进场
 *
 * 使用方式：
 * ```tsx
 * <InlineInput
 *   anchorRef={blockRef}
 *   placeholder="粘贴链接..."
 *   icon={<Link2 size={14} />}
 *   onSubmit={(value) => handleUrl(value)}
 *   onClose={() => setEditing(false)}
 * />
 * ```
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

interface InlineInputProps {
  /** 锚定参考元素 */
  anchorRef?: React.RefObject<HTMLElement>;
  /** 占位文字 */
  placeholder?: string;
  /** 左侧图标 */
  icon?: React.ReactNode;
  /** 输入提交回调 */
  onSubmit: (value: string) => void;
  /** 关闭回调 */
  onClose: () => void;
  /** 粘贴时自动提交（URL 类输入场景） */
  autoSubmitOnPaste?: boolean;
  /** 初始值 */
  defaultValue?: string;
}

export const InlineInput: React.FC<InlineInputProps> = ({
  placeholder = '输入或粘贴链接...',
  icon,
  onSubmit,
  onClose,
  autoSubmitOnPaste = true,
  defaultValue = '',
}) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  /* 挂载时自动聚焦 */
  useEffect(() => {
    // 延迟聚焦避免与 ProseMirror 的焦点管理冲突
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  /** 键盘处理：Enter 提交，Escape 取消 */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (value.trim()) {
        onSubmit(value.trim());
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [value, onSubmit, onClose]);

  /** 粘贴检测：如果粘贴的内容像是 URL，自动提交 */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (!autoSubmitOnPaste) return;

    const text = e.clipboardData.getData('text/plain').trim();
    if (!text) return;

    // 简单 URL 检测
    const isUrl = /^https?:\/\//i.test(text) || /^www\./i.test(text);
    if (isUrl) {
      e.preventDefault();
      onSubmit(text);
    }
  }, [autoSubmitOnPaste, onSubmit]);

  /** 点击外部关闭 */
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.inline-input')) {
        onClose();
      }
    };
    // 延迟注册，避免触发按钮的 click 事件立即关闭
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  return (
    <div className="inline-input motion-rise-in">
      {icon && <span className="inline-input__icon">{icon}</span>}
      <input
        ref={inputRef}
        type="text"
        className="inline-input__field"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
};
