import React from 'react';
import type { RefObject } from 'react';

import { Tooltip } from '../Tooltip/Tooltip';
import styles from './SmartExpandablePanel.module.css';
import { AppIcon } from '../icons/index';

export interface SmartPanelHeaderProps {
  query: string;
  onQueryChange: (q: string) => void;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export const SmartPanelHeader: React.FC<SmartPanelHeaderProps> = ({
  query,
  onQueryChange,
  placeholder = '搜索...',
  inputRef,
  onKeyDown,
}) => {
  return (
    <div className={styles.headerContainer}>
      <div className={`${styles.sepSearchWrapper} sep-search-wrapper`}>
        <div className={styles.searchIconBox}>
          <AppIcon name="search" size={14} aria-hidden="true" />
        </div>
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label={placeholder}
          className={`${styles.searchInput} sep-search-input`}
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <Tooltip content="清空搜索">
            <button
              type="button"
              className={styles.searchClearBtn}
              aria-label="清空搜索"
              onClick={() => {
                onQueryChange('');
                inputRef?.current?.focus();
              }}
            >
              <AppIcon name="x" size={13} aria-hidden="true" />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <div className={styles.sepSearchDivider} />
    </div>
  );
};
