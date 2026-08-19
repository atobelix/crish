/**
 * @@ 输入锚点工作区目录树。数据源 = listDirectory / getWorkspacePath，无假 TreeStore。
 * 定位复用 slash 弹层几何；自定义 Tooltip，无原生 title。
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react';
import * as Lucide from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import type { SlashMenuProps } from './composerTypes';
import type { FsDirEntry } from '../../api/workspaceFsApi';
import {
  getWorkspacePath,
  listDirectory,
} from '../../api/workspaceFsApi';
import {
  calculateSafeCursorAnchor,
  isAnchorInsideVisibleField,
  isPhysicallyVisibleNonZeroRect,
  type SafeAnchorRect,
} from './safeCursorAnchor';
import slashStyles from './TiptapSlashMenu.module.css';
import styles from './ComposerDirTree.module.css';
import { Tooltip } from '../ui';

export type ComposerDirTreeHandle = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

function parentOf(path: string, root: string): string {
  const norm = path.replace(/[\\/]+$/, '');
  const rootNorm = root.replace(/[\\/]+$/, '');
  if (norm === rootNorm) return rootNorm;
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  if (i <= 0) return rootNorm;
  const parent = norm.slice(0, i);
  return parent.length < rootNorm.length ? rootNorm : parent;
}

export const ComposerDirTree = forwardRef<
  ComposerDirTreeHandle,
  SlashMenuProps
>(function ComposerDirTree(props, ref) {
  const { isOpen = true, onClose, clientRect, editor, range, listboxId } =
    props;
  const [root, setRoot] = useState('');
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<FsDirEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const items = await listDirectory(dir);
      const sorted = [...items].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(sorted);
      setCwd(dir);
      setSelected(0);
    } catch (err) {
      setEntries([]);
      setError(err instanceof Error ? err.message : '无法列出目录');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ws = getWorkspacePath() || '';
    setRoot(ws);
    if (!ws) {
      setLoading(false);
      setError('未打开项目工作区');
      return;
    }
    void load(ws);
  }, [load]);

  const insertFile = useCallback(
    (entry: FsDirEntry) => {
      const chain = editor.chain().focus();
      if (range) chain.deleteRange(range);
      chain
        .insertContent([
          {
            type: 'mention',
            attrs: { id: entry.path, label: entry.name, kind: 'file' },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
      onClose?.();
    },
    [editor, range, onClose]
  );

  const activate = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!entry) return;
      if (entry.isDir) {
        void load(entry.path);
        return;
      }
      insertFile(entry);
    },
    [entries, insertFile, load]
  );

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.key === 'Process'
      ) {
        return false;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return true;
      }
      if (event.key === 'ArrowDown' && entries.length) {
        event.preventDefault();
        setSelected((i) => (i + 1) % entries.length);
        return true;
      }
      if (event.key === 'ArrowUp' && entries.length) {
        event.preventDefault();
        setSelected((i) => (i - 1 + entries.length) % entries.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        activate(selected);
        return true;
      }
      if (event.key === 'Backspace' && cwd && root && cwd !== root) {
        event.preventDefault();
        void load(parentOf(cwd, root));
        return true;
      }
      return false;
    },
  }));

  const editorDom = (editor as { view?: { dom?: HTMLElement } } | undefined)
    ?.view?.dom;
  const rawRect = typeof clientRect === 'function' ? clientRect() : clientRect;
  let anchor: SafeAnchorRect | DOMRect | null = null;
  if (rawRect && isPhysicallyVisibleNonZeroRect(rawRect)) {
    anchor = rawRect;
  } else {
    anchor = calculateSafeCursorAnchor({
      rawCursorRect: rawRect,
      editorViewDom: editorDom,
    });
  }
  if (!isOpen || !anchor || !isPhysicallyVisibleNonZeroRect(anchor)) {
    return null;
  }
  if (!isAnchorInsideVisibleField(anchor, editorDom)) return null;

  const side: 'top' | 'bottom' =
    'suggestedSide' in anchor &&
    (anchor.suggestedSide === 'bottom' || anchor.suggestedSide === 'top')
      ? anchor.suggestedSide
      : 'top';

  const triggerStyle: React.CSSProperties = {
    position: 'fixed',
    top: `${anchor.top}px`,
    left: `${anchor.left}px`,
    width: `${Math.max(1, anchor.width)}px`,
    height: `${Math.max(1, anchor.height)}px`,
    pointerEvents: 'none',
    visibility: 'hidden',
    zIndex: 'var(--z-popover)',
  };

  const canGoUp = Boolean(root && cwd && cwd !== root);
  const cwdLabel = cwd
    ? cwd.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/')
    : '';

  return (
    <Popover.Root open={isOpen}>
      <Popover.Anchor asChild>
        <div style={triggerStyle} />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className={slashStyles.popoverContent}
          side={side}
          align="start"
          sideOffset={8}
          avoidCollisions
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div
            className={styles.tree}
            role="tree"
            aria-label="工作区目录"
            id={listboxId}
            data-testid="composer-dir-tree"
          >
            <div className={styles.head}>
              {canGoUp ? (
                <Tooltip content="上级目录">
                  <button
                    type="button"
                    className={styles.upBtn}
                    aria-label="上级目录"
                    onClick={() => void load(parentOf(cwd, root))}
                  >
                    <Lucide.CornerLeftUp size={14} aria-hidden />
                  </button>
                </Tooltip>
              ) : null}
              <span className={styles.cwd}>{cwdLabel || '工作区'}</span>
            </div>
            {loading ? (
              <div className={styles.empty}>正在列出目录…</div>
            ) : error ? (
              <div className={styles.empty}>{error}</div>
            ) : entries.length === 0 ? (
              <div className={styles.empty}>空目录</div>
            ) : (
              entries.map((entry, index) => {
                const Icon = entry.isDir ? Lucide.Folder : Lucide.FileText;
                const active = index === selected;
                return (
                  <button
                    key={entry.path}
                    type="button"
                    role="treeitem"
                    aria-selected={active}
                    className={`${styles.row} ${active ? styles.rowActive : ''}`}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => activate(index)}
                  >
                    <span className={styles.icon} aria-hidden>
                      <Icon size={14} strokeWidth={1.75} />
                    </span>
                    <span className={styles.name}>{entry.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
