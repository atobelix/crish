import * as Lucide from 'lucide-react';

interface CheatsheetModalProps {
  onClose: () => void;
}

export function CheatsheetModal({ onClose }: CheatsheetModalProps) {
  return (
    <div
      className="cheatsheet-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="cheatsheet-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cheatsheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cheatsheet-header">
          <div className="cheatsheet-title-wrap">
            <Lucide.Keyboard
              size={16}
              style={{ color: 'var(--accent-color)' }}
              aria-hidden="true"
            />
            <h3 className="cheatsheet-title" id="cheatsheet-title">
              快捷键
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cheatsheet-close-btn"
            aria-label="关闭快捷键帮助"
          >
            <Lucide.X size={16} aria-hidden="true" />
          </button>
        </div>
        
        <div className="cheatsheet-body">
          <div className="cheatsheet-row">
            <span className="cheatsheet-label">打开系统设置</span>
            <kbd className="cheatsheet-key">Ctrl + ,</kbd>
          </div>
          <div className="cheatsheet-row">
            <span className="cheatsheet-label">分支分叉当前会话</span>
            <kbd className="cheatsheet-key">双击 Escape</kbd>
          </div>
          <div className="cheatsheet-row">
            <span className="cheatsheet-label">聊天命令行提示</span>
            <kbd className="cheatsheet-key">输入 /</kbd>
          </div>
          <div className="cheatsheet-row">
            <span className="cheatsheet-label">关闭当前选中卡片</span>
            <kbd className="cheatsheet-key">中键点击标签页</kbd>
          </div>
        </div>
        
        <div className="cheatsheet-footer-tip">
          <strong>布局提示：</strong>
          工作区卡片支持拖拽与合并。拖动标签页在其他卡片边缘悬停即可快速分屏，或在标签栏中拖拽重排。
        </div>
      </div>
    </div>
  );
}
