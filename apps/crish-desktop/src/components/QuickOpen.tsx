/**
 * QuickOpen — 极简文件查找面板（Ctrl+P）。
 * 搜索框 + 结果列表；无额外选项。
 * 后端索引为空时展示诚实空态「索引未就绪」。
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Search } from 'lucide-react';
import { createDebounced } from '../api/debouncedValue';
import { getWorkspacePath } from '../api/projectStore';
import {
  emptyReasonLabel,
  hitBasename,
  hitDirname,
  resolveEmptyReason,
  QUICK_OPEN_DEBOUNCE_MS,
  QUICK_OPEN_RESULT_LIMIT,
  type QuickOpenHit,
} from '../api/quickOpenHelpers';
import {
  getRustCoreStatus,
  rebuildSearchIndex,
  searchFilesDetailed,
} from '../api/rustCore';
import { openFileInPanel } from '../api/workspaceFsApi';
import { Tooltip } from './Tooltip';
import { useRestoreFocus } from '../hooks/useRestoreFocus';
import { FocusTrap } from './FocusTrap';
import styles from './QuickOpen.module.css';

export interface QuickOpenProps {
  onClose: () => void;
  isOpen?: boolean;
}

export function QuickOpen({ onClose, isOpen = true }: QuickOpenProps) {
  useRestoreFocus(isOpen);

  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [hits, setHits] = useState<QuickOpenHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [indexReady, setIndexReady] = useState<boolean | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);
  const requestGen = useRef(0);
  const rebuildOnce = useRef(false);

  const hasWorkspace = Boolean(getWorkspacePath()?.trim());

  const debounceRef = useRef(
    createDebounced<string>((q) => setDebouncedQuery(q), QUICK_OPEN_DEBOUNCE_MS),
  );

  useEffect(() => {
    debounceRef.current.schedule(query);
    return () => debounceRef.current.cancel();
  }, [query]);

  // On open: rebuild index once for current workspace (honest empty when no root)
  useEffect(() => {
    if (!isOpen) {
      rebuildOnce.current = false;
      return;
    }
    if (rebuildOnce.current) return;
    rebuildOnce.current = true;
    const root = getWorkspacePath()?.trim();
    if (!root) {
      setIndexReady(false);
      return;
    }
    void (async () => {
      const rebuilt = await rebuildSearchIndex(root);
      if (rebuilt) {
        setIndexReady(rebuilt.fileCount > 0);
        return;
      }
      const st = await getRustCoreStatus();
      setIndexReady(st?.searchIndexReady ?? false);
    })();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const q = debouncedQuery.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      setUnavailable(false);
      return;
    }

    const gen = ++requestGen.current;
    setLoading(true);
    setUnavailable(false);

    void (async () => {
      try {
        const outcome = await searchFilesDetailed({
          query: q,
          limit: QUICK_OPEN_RESULT_LIMIT,
        });
        if (gen !== requestGen.current) return;
        if (outcome.status === 'ok') {
          setHits(outcome.hits);
          setUnavailable(false);
        } else {
          // missing / error：浏览器预览或命令未注册
          setHits([]);
          setUnavailable(true);
        }
      } catch {
        if (gen !== requestGen.current) return;
        setHits([]);
        setUnavailable(true);
      } finally {
        if (gen === requestGen.current) setLoading(false);
      }
    })();
  }, [debouncedQuery, isOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [hits, debouncedQuery]);

  const emptyReason = resolveEmptyReason({
    query: debouncedQuery,
    loading,
    hits,
    unavailable,
    hasWorkspace,
    indexReady,
  });

  const openHit = useCallback(
    (hit: QuickOpenHit) => {
      openFileInPanel(hit.path);
      onClose();
    },
    [onClose],
  );

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hits.length === 0) return;
      setActiveIndex((i) => Math.min(i + 1, hits.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length === 0) return;
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[activeIndex];
      if (hit) openHit(hit);
    }
  };

  if (!isOpen) return null;

  return (
    <FocusTrap active={isOpen} initialFocusRef={inputRef}>
      <div
        className={styles.overlay}
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className={styles.panel}
          role="dialog"
          aria-modal="true"
          aria-label="快速打开文件"
        >
          <div className={styles.searchRow}>
            <Search size={16} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              className={styles.searchInput}
              placeholder="搜索文件…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              aria-label="搜索文件"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                hits[activeIndex] ? `${listId}-opt-${activeIndex}` : undefined
              }
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {emptyReason ? (
            <div className={styles.empty} role="status">
              {emptyReasonLabel(emptyReason)}
            </div>
          ) : (
            <ul
              id={listId}
              className={styles.list}
              role="listbox"
              aria-label="搜索结果"
            >
              {hits.map((hit, i) => (
                <li key={`${hit.path}-${i}`} role="presentation">
                    <Tooltip content={hit.path} side="right">
                      <button
                        type="button"
                        id={`${listId}-opt-${i}`}
                        role="option"
                        aria-selected={i === activeIndex}
                        className={`${styles.item} ${i === activeIndex ? styles.itemActive : ''}`}
                        onMouseEnter={() => setActiveIndex(i)}
                        onClick={() => openHit(hit)}
                      >
                        <span className={styles.itemName}>{hitBasename(hit.path)}</span>
                        {hitDirname(hit.path) ? (
                          <span className={styles.itemDir}>{hitDirname(hit.path)}</span>
                        ) : null}
                      </button>
                    </Tooltip>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.hint}>
            <span>
              <kbd className={styles.kbd}>↑</kbd>
              <kbd className={styles.kbd}>↓</kbd> 选择
            </span>
            <span>
              <kbd className={styles.kbd}>Enter</kbd> 打开
            </span>
            <span>
              <kbd className={styles.kbd}>Esc</kbd> 关闭
            </span>
          </div>
        </div>
      </div>
    </FocusTrap>
  );
}
