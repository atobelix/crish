import React, { useRef, useEffect } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip/Tooltip';
import styles from './ThoughtSearchBar.module.css';

export interface ThoughtSearchBarProps {
  query: string;
  onChange: (q: string) => void;
  onClose?: () => void;
  matchesCount?: number;
  activeMatchIndex?: number;
  onNext?: () => void;
  onPrev?: () => void;
}

export const ThoughtSearchBar: React.FC<ThoughtSearchBarProps> = ({
  query,
  onChange,
  onClose,
  matchesCount = 0,
  activeMatchIndex = 0,
  onNext,
  onPrev,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className={styles.searchBar}>
      <Search size={14} className={styles.searchIcon} />
      <input
        ref={inputRef}
        type="text"
        className={styles.searchInput}
        placeholder="在思考链中检索关键词 (支持正则与中英文)..."
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onClose) {
            onClose();
          } else if (e.key === 'Enter') {
            if (e.shiftKey) {
              onPrev?.();
            } else {
              onNext?.();
            }
          }
        }}
      />
      {query ? (
        <div className={styles.searchActions}>
          <span className={styles.matchesCount}>
            {matchesCount > 0
              ? `${activeMatchIndex + 1} / ${matchesCount}`
              : '无匹配'}
          </span>
          {matchesCount > 0 && onPrev && (
            <Tooltip content="上一个匹配 (Shift+Enter)">
              <button
                type="button"
                className={styles.navBtn}
                onClick={onPrev}
                aria-label="上一个匹配"
              >
                <ChevronUp size={14} />
              </button>
            </Tooltip>
          )}
          {matchesCount > 0 && onNext && (
            <Tooltip content="下一个匹配 (Enter)">
              <button
                type="button"
                className={styles.navBtn}
                onClick={onNext}
                aria-label="下一个匹配"
              >
                <ChevronDown size={14} />
              </button>
            </Tooltip>
          )}
          <Tooltip content="清空搜索">
            <button
              type="button"
              className={styles.clearBtn}
              onClick={() => onChange('')}
              aria-label="清空搜索"
            >
              <X size={13} />
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
};
