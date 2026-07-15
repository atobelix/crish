import { useState, useEffect, useRef } from 'preact/hooks';
import { appState } from '../core/app-state';
import { eventBus } from '../core/event-bus';
import { IconSearch, IconMessageSquare, IconFileCode } from './icons';

interface SearchResult {
  id: string;
  type: 'session' | 'file';
  title: string;
  subtitle?: string;
  action: () => void;
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  const state = appState.getState();
  const sessions = state.sessions || [];
  const changedFiles = state.changedFiles || [];

  const results: SearchResult[] = [];
  const q = query.trim().toLowerCase();

  if (q) {
    sessions.forEach(s => {
      const title = s.title || '未命名对话';
      if (title.toLowerCase().includes(q)) {
        results.push({
          id: `session-${s.id}`,
          type: 'session',
          title,
          subtitle: s.workingDirectory ? `项目: ${s.workingDirectory.split(/[\\/]/).pop()}` : undefined,
          action: () => { appState.switchSession(s.id); setOpen(false); },
        });
      }
    });
    changedFiles.forEach(f => {
      if (f.path.toLowerCase().includes(q)) {
        results.push({
          id: `file-${f.path}`,
          type: 'file',
          title: f.path.split(/[\\/]/).pop() || f.path,
          subtitle: f.path,
          action: () => { eventBus.emit('explorer:open-file', f.path); setOpen(false); },
        });
      }
    });
  }

  const handleSelect = (index: number) => {
    if (results[index]) {
      results[index].action();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % Math.max(results.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + Math.max(results.length, 1)) % Math.max(results.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect(selectedIndex);
    }
  };

  if (!open) return null;

  return (
    <div class="repl-global-search-overlay" onClick={() => setOpen(false)}>
      <div class="repl-global-search-modal" onClick={e => e.stopPropagation()}>
        <div class="repl-global-search-input-wrap">
          <IconSearch />
          <input
            ref={inputRef}
            type="text"
            class="repl-global-search-input"
            placeholder="搜索会话、文件..."
            value={query}
            onInput={e => { setQuery((e.target as HTMLInputElement).value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
          />
          <span class="repl-global-search-hint">ESC 关闭</span>
        </div>
        {results.length > 0 && (
          <div class="repl-global-search-results">
            {results.map((r, i) => (
              <div
                key={r.id}
                class={`repl-global-search-item ${i === selectedIndex ? 'selected' : ''}`}
                onClick={() => handleSelect(i)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span class="repl-global-search-icon">
                  {r.type === 'session' ? <IconMessageSquare /> : <IconFileCode />}
                </span>
                <div class="repl-global-search-meta">
                  <div class="repl-global-search-title">{r.title}</div>
                  {r.subtitle && <div class="repl-global-search-subtitle">{r.subtitle}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
        {query && results.length === 0 && (
          <div class="repl-global-search-empty">
            <div>未找到匹配结果</div>
            <div class="repl-global-search-empty-hint">尝试其他关键词</div>
          </div>
        )}
      </div>
    </div>
  );
}
