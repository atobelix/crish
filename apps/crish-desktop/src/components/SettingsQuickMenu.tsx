import React, { useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import { readStoredTheme, setTheme, type UiTheme } from '../api/themeStore';

interface Props {
  onShowToast?: (msg: string) => void;
}

/**
 * 侧栏「设置」旁的快捷菜单：常用项先点这里，完整设置从菜单进入。
 */
export const SettingsQuickMenu: React.FC<Props> = ({ onShowToast }) => {
  const [open, setOpen] = useState(false);
  const [theme, setThemeLocal] = useState<UiTheme>(() => readStoredTheme());
  const uiSize = useLayoutStore((s) => s.uiSize);
  const setUiSize = useLayoutStore((s) => s.setUiSize);
  const openSettings = useLayoutStore((s) => s.openSettings);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const applyTheme = (t: UiTheme) => {
    setTheme(t);
    setThemeLocal(t);
  };

  const go = (tab?: string) => {
    setOpen(false);
    openSettings(tab);
  };

  return (
    <div className="sb-quick-wrap" ref={rootRef}>
      <button
        type="button"
        className={`sidebar-footer-settings ${open ? 'is-open' : ''}`}
        title="快捷设置"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Lucide.Settings size={16} />
        <span>设置</span>
        <Lucide.ChevronUp size={14} className="sb-quick-chev" />
      </button>

      {open && (
        <div className="sb-quick-menu" role="menu">
          <div className="sb-quick-section">
            <div className="sb-quick-label">主题</div>
            <div className="ui-segment ui-segment--inline sb-quick-segment">
              <button
                type="button"
                className={`ui-segment-item ${theme !== 'dark' ? 'active' : ''}`}
                onClick={() => applyTheme('default')}
              >
                浅色
              </button>
              <button
                type="button"
                className={`ui-segment-item ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => applyTheme('dark')}
              >
                深色
              </button>
            </div>
          </div>

          <div className="sb-quick-section">
            <div className="sb-quick-label">间距</div>
            <div className="ui-segment ui-segment--inline sb-quick-segment">
              {(
                [
                  { id: 'small' as const, label: '紧凑' },
                  { id: 'medium' as const, label: '标准' },
                  { id: 'large' as const, label: '宽松' },
                ]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ui-segment-item ${uiSize === opt.id ? 'active' : ''}`}
                  onClick={() => setUiSize(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="sb-quick-divider" />

          <button type="button" className="sb-quick-item" role="menuitem" onClick={() => go('models')}>
            <Lucide.Cpu size={16} />
            <span>模型与密钥</span>
          </button>
          <button type="button" className="sb-quick-item" role="menuitem" onClick={() => go('appearance')}>
            <Lucide.Palette size={16} />
            <span>外观与字体</span>
          </button>
          <button type="button" className="sb-quick-item" role="menuitem" onClick={() => go()}>
            <Lucide.SlidersHorizontal size={16} />
            <span>全部设置</span>
          </button>

          <div className="sb-quick-divider" />

          <button
            type="button"
            className="sb-quick-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onShowToast?.('当前已是最新版本');
            }}
          >
            <Lucide.RefreshCw size={16} />
            <span>检查更新</span>
          </button>
        </div>
      )}
    </div>
  );
};
