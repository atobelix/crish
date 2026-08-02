import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './FilesCard.module.css';
import { Tooltip } from '../Tooltip';
import { ChevronRight, File, FileCode2, FileText, Folder, Image, Search, Table } from 'lucide-react';
import { detectFileKind, listDirectory, pathDirname, pathRelativeToRoot, resolveWorkspacePath, type FsDirEntry } from '../../api/workspaceFsApi';
import { fileExtColor } from '../../api/codeHighlight';
import type { ViewMode } from './hooks/useFilePreview';

function joinLocal(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function BcFileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  const color = fileExtColor(name);
  const sz = 14;
  if (k === 'image') return <Image size={sz} style={{ color }} aria-hidden />;
  if (k === 'pdf') return <FileText size={sz} style={{ color }} aria-hidden />;
  if (k === 'table') return <Table size={sz} style={{ color }} aria-hidden />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|css|html|json|md|yml|yaml)$/i.test(name)) return <FileCode2 size={sz} style={{ color }} aria-hidden />;
  return <File size={sz} style={{ color }} aria-hidden />;
}

interface BreadcrumbItem {
  label: string;
  path: string;
  isFile?: boolean;
}

interface FileBreadcrumbProps {
  root: string;
  cwd: string;
  selected: string | null;
  view: ViewMode;
  onNavigate: (path: string) => void;
  onRefresh: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export const FileBreadcrumb = React.memo(function FileBreadcrumb({
  root, cwd, selected, view, onNavigate, onRefresh, onOpenFile,
}: FileBreadcrumbProps) {
  const [bcFlyout, setBcFlyout] = useState<{
    path: string; label: string; entries: FsDirEntry[]; loading: boolean; filter: string;
  } | null>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const bcFilterRef = useRef<HTMLInputElement>(null);
  const bcTriggerRef = useRef<HTMLButtonElement>(null);

  const breadcrumbs: BreadcrumbItem[] = useMemo(() => {
    if (!root) return [];
    const dir = view === 'detail' && selected ? pathDirname(selected) || root : cwd || root;
    const rel = pathRelativeToRoot(dir, root);
    const items: BreadcrumbItem[] = [{ label: '项目', path: root }];
    if (rel && rel !== '.') {
      let acc = root;
      for (const part of rel.replace(/\\/g, '/').split('/').filter(Boolean)) {
        acc = joinLocal(acc, part);
        items.push({ label: part, path: acc });
      }
    }
    if (view === 'detail' && selected) {
      items.push({ label: selected.split(/[\\/]/).pop() || '', path: selected, isFile: true });
    }
    return items;
  }, [cwd, root, selected, view]);

  const loadDir = useCallback(async (path: string) => listDirectory(resolveWorkspacePath(path)), []);

  const openBcFlyout = useCallback(async (dirPath: string, label: string) => {
    if (bcFlyout?.path === dirPath) {
      setBcFlyout(null);
      requestAnimationFrame(() => bcTriggerRef.current?.focus());
      return;
    }
    setBcFlyout({ path: dirPath, label, entries: [], loading: true, filter: '' });
    try {
      const list = await loadDir(dirPath);
      setBcFlyout((prev) => prev && prev.path === dirPath ? { ...prev, entries: list, loading: false } : prev);
      requestAnimationFrame(() => bcFilterRef.current?.focus());
    } catch {
      setBcFlyout(null);
      requestAnimationFrame(() => bcTriggerRef.current?.focus());
    }
  }, [bcFlyout?.path, loadDir]);

  useEffect(() => {
    if (!bcFlyout) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (crumbsRef.current?.contains(t)) return;
      setBcFlyout(null);
      requestAnimationFrame(() => bcTriggerRef.current?.focus());
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setBcFlyout(null); requestAnimationFrame(() => bcTriggerRef.current?.focus()); }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [bcFlyout]);

  const bcFlyoutFiltered = useMemo(() => {
    if (!bcFlyout) return [];
    const q = bcFlyout.filter.trim().toLowerCase();
    let list = bcFlyout.entries;
    if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
    return [...list].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [bcFlyout]);

  if (!root) return null;

  return (
    <div className={styles.filesCrumbs} ref={crumbsRef} aria-label="工作区相对路径">
      {breadcrumbs.length === 0 ? (
        <span className={`${styles.filesBcChip} ${styles.filesBcChipMuted || 'files-bc-chip--muted'}`}>项目</span>
      ) : (
        breadcrumbs.map((b, i) => {
          const isLast = i === breadcrumbs.length - 1;
          const canNav = !b.isFile;
          const flyOpen = bcFlyout?.path === b.path;
          return (
            <React.Fragment key={`${b.path}-${i}`}>
              {i > 0 ? <span className={styles.filesBcSep}>/</span> : null}
              {canNav ? (
                <span className={styles.filesBcSeg}>
                  <Tooltip content={i === 0 ? '项目根目录 · 点击列出内容' : `${b.path} · 点击列出该层`}>
                    <button
                      type="button"
                      className={`${styles.filesBcChip} ${flyOpen ? styles.isOpen : ''}`}
                      aria-haspopup="listbox"
                      aria-expanded={flyOpen}
                      onClick={(e) => { bcTriggerRef.current = e.currentTarget; void openBcFlyout(b.path, b.label); }}
                      onDoubleClick={() => { setBcFlyout(null); requestAnimationFrame(() => bcTriggerRef.current?.focus()); onNavigate(b.path); }}
                    >
                      {b.label}
                    </button>
                  </Tooltip>
                  {flyOpen && bcFlyout ? (
                    <div className={styles.filesBcFlyout} role="listbox" aria-label={`${b.label} 目录`}>
                      <div className={styles.filesBcFlyoutSearch}>
                        <Search size={14} aria-hidden />
                        <input ref={bcFilterRef} type="search" placeholder="筛选文件…" value={bcFlyout.filter}
                          onChange={(e) => setBcFlyout((prev) => prev ? { ...prev, filter: e.target.value } : prev)}
                          onKeyDown={(e) => { if (e.key === 'Escape') { setBcFlyout(null); requestAnimationFrame(() => bcTriggerRef.current?.focus()); } }}
                        />
                      </div>
                      <div className={styles.filesBcFlyoutList}>
                        {bcFlyout.loading ? <div className={styles.filesBcFlyoutEmpty}>加载中…</div>
                        : bcFlyoutFiltered.length === 0 ? <div className={styles.filesBcFlyoutEmpty}>{bcFlyout.filter.trim() ? '无匹配' : '空目录'}</div>
                        : bcFlyoutFiltered.map((ent) => (
                          <button key={ent.path} type="button" role="option"
                            className={`${styles.filesBcFlyoutItem} ${selected === ent.path ? styles.isActive : ''}`}
                            onClick={() => {
                              if (ent.isDir) { void openBcFlyout(ent.path, ent.name); void onRefresh(ent.path); }
                              else { setBcFlyout(null); requestAnimationFrame(() => bcTriggerRef.current?.focus()); void onOpenFile(ent.path); }
                            }}>
                            {ent.isDir ? <><ChevronRight size={13} className={styles.filesBcFlyoutChev} aria-hidden /><Folder size={14} aria-hidden /></>
                            : <><span className={`${styles.filesBcFlyoutChev} ${styles.isLeaf}`} /><BcFileIcon name={ent.name} /></>}
                            <span className={styles.filesBcFlyoutName}>{ent.name}</span>
                          </button>
                        ))}
                      </div>
                      <button type="button" className={styles.filesBcFlyoutGoto}
                        onClick={() => { setBcFlyout(null); requestAnimationFrame(() => bcTriggerRef.current?.focus()); onNavigate(bcFlyout.path); }}>
                        打开此目录
                      </button>
                    </div>
                  ) : null}
                </span>
              ) : (
                <span className={`${styles.filesBcChip} ${isLast ? styles.filesBcChipFile : ''}`}>
                  {b.label}
                </span>
              )}
            </React.Fragment>
          );
        })
      )}
    </div>
  );
});
