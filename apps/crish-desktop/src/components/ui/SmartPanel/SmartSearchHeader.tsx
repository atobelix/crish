import React from 'react';
import type { ReactNode, RefObject, KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import styles from './SmartPanel.module.css';

export interface SmartSearchHeaderProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rightActions?: ReactNode;
  inputRef?: RefObject<HTMLInputElement | null>;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
}

export const SmartSearchHeader: React.FC<SmartSearchHeaderProps> = ({
  value,
  onChange,
  placeholder = '搜索...',
  rightActions,
  inputRef,
  onKeyDown,
  autoFocus = true,
}) => {
  return (
    <div className={styles.headerContainer}>
      <div className={`${styles.sepSearchWrapper} sep-search-wrapper`}>
        <div className={styles.searchIconBox}>
          <Search size={14} aria-hidden="true" strokeWidth={1.8} />
        </div>
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label={placeholder}
          className={`${styles.searchInput} sep-search-input`}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoFocus={autoFocus}
          spellCheck={false}
        />
        {value ? (
          <button
            type="button"
            className={styles.searchClearBtn}
            aria-label="清空搜索"
            onClick={() => {
              onChange('');
              inputRef?.current?.focus();
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        ) : null}
        {rightActions ? (
          <div className={styles.searchRightActions}>
            {rightActions}
          </div>
        ) : null}
      </div>
      <div className={styles.sepSearchDivider} />
    </div>
  );
};

SmartSearchHeader.displayName = 'SmartSearchHeader';
