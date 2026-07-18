/**
 * 输入区「+」菜单：附件 / 技能 / 插件 / MCP / 扩展中心
 * 紧凑单列，与模型选择菜单同气质。
 */
import React, { useEffect, useId, useRef } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ComposePlusMenu.module.css';
import { Tooltip } from './settings/SettingsUI';
import { openSettings } from '../api/storeAccess';
import { emitUiEvent } from '../api/uiEvents';

type Props = {
  open: boolean;
  onClose: () => void;
  onAddFiles: () => void;
  /** 插入技能斜杠提示到输入框 */
  onInsertSkillSlash?: () => void;
  id?: string;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
};

type MenuItem = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  onPick: () => void;
};

export const ComposePlusMenu: React.FC<Props> = ({
  open,
  onClose,
  onAddFiles,
  onInsertSkillSlash,
  id: idProp,
  restoreFocusRef,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const autoId = useId();
  const menuId = idProp || autoId;
  const restoreOnCloseRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    restoreOnCloseRef.current = false;

    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        restoreOnCloseRef.current = false;
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        restoreOnCloseRef.current = true;
        onClose();
        queueMicrotask(() => {
          restoreFocusRef?.current?.focus?.();
        });
        return;
      }
      if (
        e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === 'Home' ||
        e.key === 'End'
      ) {
        e.preventDefault();
        const items = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
        if (!items || items.length === 0) return;
        const list = Array.from(items);
        const cur = list.indexOf(document.activeElement as HTMLButtonElement);
        let next = 0;
        if (e.key === 'End') next = list.length - 1;
        else if (e.key === 'ArrowUp') next = cur <= 0 ? list.length - 1 : cur - 1;
        else if (e.key === 'ArrowDown') next = cur < 0 || cur >= list.length - 1 ? 0 : cur + 1;
        list[next]?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => firstItemRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
      if (restoreOnCloseRef.current) {
        restoreFocusRef?.current?.focus?.();
        restoreOnCloseRef.current = false;
      }
    };
  }, [open, onClose, restoreFocusRef]);

  if (!open) return null;

  const items: MenuItem[] = [
    {
      id: 'file',
      label: '添加文件',
      hint: '图片或文档',
      icon: <Lucide.Paperclip size={13} strokeWidth={1.75} />,
      onPick: () => {
        restoreOnCloseRef.current = false;
        onAddFiles();
        onClose();
      },
    },
    {
      id: 'skill',
      label: '使用技能',
      hint: '输入 / 选择技能',
      icon: <Lucide.Sparkles size={13} strokeWidth={1.75} />,
      onPick: () => {
        onInsertSkillSlash?.();
        onClose();
        queueMicrotask(() => restoreFocusRef?.current?.focus?.());
      },
    },
    {
      id: 'plugin',
      label: '插件',
      hint: '扩展包',
      icon: <Lucide.Puzzle size={13} strokeWidth={1.75} />,
      onPick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'mcp',
      label: 'MCP 工具',
      hint: '服务与工具开关',
      icon: <Lucide.Cable size={13} strokeWidth={1.75} />,
      onPick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'extensions',
      label: '扩展中心',
      hint: '发现 / 安装',
      icon: <Lucide.Blocks size={13} strokeWidth={1.75} />,
      onPick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'schedule',
      label: '定时任务',
      icon: <Lucide.Clock size={13} strokeWidth={1.75} />,
      onPick: () => {
        onClose();
        emitUiEvent('open-scheduled');
      },
    },
  ];

  return (
    <div
      ref={rootRef}
      id={menuId}
      className={`${styles.root} ${styles.slim}`}
      role="menu"
      aria-label="添加"
      data-cplus-density="compact"
    >
      <div className={styles.main} role="none">
        {items.map((item, idx) => (
          <Tooltip key={item.id} content={item.hint || item.label}>
            <button
              ref={idx === 0 ? firstItemRef : undefined}
              type="button"
              className={styles.item}
              role="menuitem"
              aria-label={item.hint ? `${item.label}，${item.hint}` : item.label}
              onClick={item.onPick}
            >
              <span className={styles.icon} aria-hidden>
                {item.icon}
              </span>
              <span className={styles.text}>
                <span className={styles.title}>{item.label}</span>
                {item.hint ? (
                  <span className={styles.desc}>{item.hint}</span>
                ) : null}
              </span>
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
};
