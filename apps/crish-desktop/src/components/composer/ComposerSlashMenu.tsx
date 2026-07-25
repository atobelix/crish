import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import styles from '../ChatComposer.module.css';
import { slashMenuPick } from '../api/resolveSlashCommand';
import type { SlashCommandItem } from '../ChatComposer';

export interface ComposerSlashMenuHandle {
  handleKeyDown: (e: React.KeyboardEvent, chatInput: string) => boolean | void;
}

interface ComposerSlashMenuProps {
  listboxId: string;
  setChatInput: (v: string) => void;
  slashMenuOpen: boolean;
  setSlashMenuOpen: (v: boolean) => void;
  slashSelectedIndex: number;
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  filteredCommands: SlashCommandItem[];
  onOpenSchedule: () => void;
  focusComposerTextarea: () => void;
}

export const ComposerSlashMenu = React.forwardRef<ComposerSlashMenuHandle, ComposerSlashMenuProps>(({
  listboxId,
  setChatInput,
  slashMenuOpen,
  setSlashMenuOpen,
  slashSelectedIndex,
  setSlashSelectedIndex,
  filteredCommands,
  onOpenSchedule,
  focusComposerTextarea,
}) => {
  const slashRootRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLDivElement | null>(null);

  const safeIndex = useMemo(() => {
    if (filteredCommands.length === 0) return 0;
    return Math.min(
      Math.max(0, slashSelectedIndex),
      filteredCommands.length - 1,
    );
  }, [filteredCommands.length, slashSelectedIndex]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    if (slashSelectedIndex !== safeIndex) {
      setSlashSelectedIndex(safeIndex);
    }
  }, [slashMenuOpen, slashSelectedIndex, safeIndex, setSlashSelectedIndex]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [slashMenuOpen, safeIndex, filteredCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (slashRootRef.current?.contains(t)) return;
      const el = t as HTMLElement | null;
      if (el?.closest?.('.input-container')) return;
      setSlashMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [slashMenuOpen, setSlashMenuOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, chatInput: string): boolean | void => {
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
    },
    [
      filteredCommands,
      safeIndex,
      setSlashMenuOpen,
      setSlashSelectedIndex,
      focusComposerTextarea,
      applySlashSelection,
    ],
  );

  useImperativeHandle(
    ref,
    () => ({ handleKeyDown }),
    [handleKeyDown],
  );

  const applySlashSelection = useCallback(
    (cmd: string) => {
      setSlashMenuOpen(false);
      const result = slashMenuPick(cmd);
      if (result.action === 'open-schedule') {
        setChatInput('');
        onOpenSchedule();
        requestAnimationFrame(focusComposerTextarea);
        return;
      }
      setChatInput(result.text);
      requestAnimationFrame(focusComposerTextarea);
    },
    [focusComposerTextarea, onOpenSchedule, setChatInput, setSlashMenuOpen],
  );

  const optionId = (i: number) => `${listboxId}-opt-${i}`;

  const slashActiveDesc =
    slashMenuOpen && filteredCommands.length > 0
      ? optionId(safeIndex)
      : undefined;

  return slashMenuOpen ? (
    <div
      ref={slashRootRef}
      id={listboxId}
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
              ref={active ? activeItemRef : undefined}
              role="option"
              aria-selected={active}
              className={`${styles.slashItem}${active ? ` ${styles.isActive}` : ''}`}
              onClick={() => applySlashSelection(c.cmd)}
              onMouseEnter={() => setSlashSelectedIndex(i)}
            >
              <span className={styles.slashCmd}>{c.cmd}</span>
              <span className={styles.slashDesc}>{c.desc}</span>
            </div>
          );
        })
      )}
    </div>
  ) : null;
});
