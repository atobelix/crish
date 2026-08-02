/**
 * 斜杠命令菜单（PE-05 T05.3 约定例外，不接 ui/Menu 基座）：
 * - 纯渲染：键盘漫游保持在父级 ChatComposer（handleSlashKeyDown），
 *   aria-activedescendant 由父级管理，本组件只渲染 listbox 与选项；
 * - 定位：随输入框内联布局（CSS 绝对定位），如未来需要视口钳位/避让，
 *   必须统一走 ui/Menu/position.ts 的 clampPosition（坐标计算单源），
 *   不得在本文件引入新的坐标实现。
 */
import React from 'react';
import styles from './ChatComposer.module.css';

export type SlashCommandItem = { cmd: string; desc: string };

export interface ComposerSlashMenuProps {
  id: string;
  filteredCommands: SlashCommandItem[];
  safeIndex: number;
  slashActiveDesc?: string | undefined;
  slashRootRef: React.RefObject<HTMLDivElement | null>;
  activeItemRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (cmd: string) => void;
  onMouseEnterIndex: (i: number) => void;
  optionId: (i: number) => string;
}

export const ComposerSlashMenu: React.FC<ComposerSlashMenuProps> = ({
  id,
  filteredCommands,
  safeIndex,
  slashActiveDesc,
  slashRootRef,
  activeItemRef,
  onSelect,
  onMouseEnterIndex,
  optionId,
}) => {
  return (
    <div
      ref={slashRootRef as React.RefObject<HTMLDivElement>}
      id={id}
      className={styles.slashPopover}
      role="listbox"
      aria-label="斜杠命令"
      aria-activedescendant={slashActiveDesc}
    >
      {filteredCommands.length === 0 ? (
        <div className={styles.slashEmpty} role="presentation">
          无匹配命令
        </div>
      ) : (
        filteredCommands.map((c, i) => {
          const active = i === safeIndex;
          return (
            <div
              key={c.cmd}
              id={optionId(i)}
              ref={active ? (activeItemRef as React.RefObject<HTMLDivElement>) : undefined}
              role="option"
              aria-selected={active}
              className={`${styles.slashItem}${active ? ` ${styles.isActive}` : ''}`}
              onClick={() => onSelect(c.cmd)}
              onMouseEnter={() => onMouseEnterIndex(i)}
            >
              <span className={styles.slashCmd}>{c.cmd}</span>
              <span className={styles.slashDesc}>{c.desc}</span>
            </div>
          );
        })
      )}
    </div>
  );
};

export function handleSlashKeyDown(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  slashMenuOpen: boolean,
  filteredCommands: SlashCommandItem[],
  safeIndex: number,
  chatInput: string,
  setSlashMenuOpen: (v: boolean) => void,
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>,
  applySlashSelection: (cmd: string) => void,
  focusComposerTextarea: () => void,
): boolean {
  if (!slashMenuOpen) return false;
  const n = filteredCommands.length;

  if (e.key === 'Escape') {
    e.preventDefault();
    setSlashMenuOpen(false);
    requestAnimationFrame(focusComposerTextarea);
    return true;
  }
  if (e.key === 'Tab') {
    setSlashMenuOpen(false);
    return false;
  }
  if (n === 0) {
    if (e.key === 'Enter' && !e.shiftKey) {
      const bare = chatInput.trim();
      if (bare === '/' || bare === '／') {
        e.preventDefault();
        return true;
      }
    }
    return false;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setSlashSelectedIndex((prev) => (prev + 1) % n);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setSlashSelectedIndex((prev) => (prev - 1 + n) % n);
    return true;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    setSlashSelectedIndex(0);
    return true;
  }
  if (e.key === 'End') {
    e.preventDefault();
    setSlashSelectedIndex(n - 1);
    return true;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const selected = filteredCommands[safeIndex];
    if (selected) applySlashSelection(selected.cmd);
    return true;
  }
  return false;
}
