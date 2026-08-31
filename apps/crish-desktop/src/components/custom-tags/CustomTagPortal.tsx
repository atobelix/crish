/**
 * CustomTagPortal.tsx
 *
 * React Portal 自定义组件顶层沙箱挂载器
 *
 * 核心机制：
 * 1. 将自定义组件呼出的交互浮层、比对全景大图或弹窗挂载至顶层 DOM 节点 (#crish-artifact-portal-root)；
 * 2. 彻底解耦消息气泡的 CSS overflow: hidden 及局部层叠上下文限制；
 * 3. 支持 ESC 快捷键关闭与外部遮罩点击拦截。
 */

import React, { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface CustomTagPortalProps {
  children: ReactNode;
  containerId?: string;
  isOpen?: boolean;
  onClose?: () => void;
}

export const CustomTagPortal: React.FC<CustomTagPortalProps> = ({
  children,
  containerId = 'crish-artifact-portal-root',
  isOpen = true,
  onClose,
}) => {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    let el = document.getElementById(containerId);
    let created = false;

    if (!el) {
      el = document.createElement('div');
      el.id = containerId;
      el.setAttribute('data-portal-root', 'true');
      document.body.appendChild(el);
      created = true;
    }

    setContainer(el);

    return () => {
      // 仅当挂载点无子节点且由本实例创建时做清理
      if (created && el && el.parentNode && el.childNodes.length === 0) {
        el.parentNode.removeChild(el);
      }
    };
  }, [containerId]);

  useEffect(() => {
    if (!isOpen || !onClose) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !container) {
    return null;
  }

  return createPortal(children, container);
};
