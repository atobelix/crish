import React, { useEffect, useId, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';

export type SettingsSelectOption = {
  value: string;
  label: string;
  /** 分组标题，同 group 连续显示 */
  group?: string;
  /** 预览字体 */
  previewFamily?: string;
  hint?: string;
};

interface Props {
  value: string;
  options: SettingsSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** 下拉最大高度 */
  maxHeight?: number;
  className?: string;
  /** 列表底部插槽（自定义输入等） */
  footer?: React.ReactNode;
  /** 触发器额外右侧内容（扫描图标等），在 chevron 前 */
  trailing?: React.ReactNode;
  /** 打开时回调（可触发扫描） */
  onOpen?: () => void;
  /** 预览当前选中用的 font-family */
  valuePreviewFamily?: string;
}

/**
 * 设置页自定义下拉：与主界面 cplus / panel-dropdown 气质一致，非系统原生 select。
 */
export const SettingsSelect: React.FC<Props> = ({
  value,
  options,
  onChange,
  disabled,
  placeholder = '选择…',
  maxHeight = 280,
  className,
  footer,
  trailing,
  onOpen,
  valuePreviewFamily,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const label = selected?.label || placeholder;

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

  const toggle = () => {
    if (disabled) return;
    setOpen((v) => {
      const next = !v;
      if (next) onOpen?.();
      return next;
    });
  };

  // group options for rendering
  let lastGroup: string | undefined;

  return (
    <div
      className={`settings-select ${open ? 'is-open' : ''} ${className || ''}`}
      ref={rootRef}
    >
      <div className="settings-select-trigger-row">
        <button
          type="button"
          className="settings-select-trigger"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={toggle}
        >
          <span
            className="settings-select-value"
            style={
              valuePreviewFamily || selected?.previewFamily
                ? { fontFamily: valuePreviewFamily || selected?.previewFamily }
                : undefined
            }
          >
            {label}
          </span>
          <Lucide.ChevronDown size={14} className="settings-select-chev" />
        </button>
        {trailing}
      </div>

      {open && (
        <div className="settings-select-menu" role="listbox" id={listId} style={{ maxHeight }}>
          <div className="settings-select-scroll">
            {options.map((opt) => {
              const showGroup = opt.group && opt.group !== lastGroup;
              if (opt.group) lastGroup = opt.group;
              const active = opt.value === value;
              return (
                <React.Fragment key={opt.value}>
                  {showGroup ? (
                    <div className="settings-select-group">{opt.group}</div>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`settings-select-item ${active ? 'is-active' : ''}`}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    <span
                      className="settings-select-item-label"
                      style={opt.previewFamily ? { fontFamily: opt.previewFamily } : undefined}
                    >
                      {opt.label}
                    </span>
                    {opt.hint ? (
                      <span className="settings-select-item-hint">{opt.hint}</span>
                    ) : null}
                    {active ? (
                      <Lucide.Check size={14} className="settings-select-check" />
                    ) : null}
                  </button>
                </React.Fragment>
              );
            })}
            {!options.length ? (
              <div className="settings-select-empty">暂无选项</div>
            ) : null}
          </div>
          {footer ? <div className="settings-select-footer">{footer}</div> : null}
        </div>
      )}
    </div>
  );
};
