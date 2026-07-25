import { useCallback, useEffect, useRef, useState } from 'react';
import { countPendingFileAnnotations, detectFileKind, FILE_PREVIEW_CHUNK_LINES, FILE_PREVIEW_MAX_LINES, isMarkdownFilename, nextFilePreviewLineBudget, pathBasename, pathDirname, readTextFile, resolveWorkspacePath, toAssetUrl, writeTextFile } from '../../../api/workspaceFsApi';
import { listOpenOptionsForFile, type HostOpener } from '../../../api/hostOpenersApi';
import { pathRelativeToRoot } from '../../../api/workspaceFsApi';

export type ViewMode = 'browse' | 'detail';

export function useFilePreview() {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('browse');
  const [content, setContent] = useState('');
  const [editBuf, setEditBuf] = useState('');
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [lineBudget, setLineBudget] = useState(FILE_PREVIEW_CHUNK_LINES);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mdMode, setMdMode] = useState<'render' | 'source'>('render');
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fileOpeners, setFileOpeners] = useState<HostOpener[]>([]);
  const [openDefaultLabel, setOpenDefaultLabel] = useState('打开');
  const [actionHint, setActionHint] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(() => countPendingFileAnnotations());
  const openedContentRef = useRef<string>('');
  const actionHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDirtyChangeRef = useRef<((dirty: boolean) => void) | undefined>();

  const showActionHint = useCallback((msg: string) => {
    setActionHint(msg);
    if (actionHintTimerRef.current) clearTimeout(actionHintTimerRef.current);
    actionHintTimerRef.current = setTimeout(() => { setActionHint(null); actionHintTimerRef.current = null; }, 4800);
  }, []);

  const clearActionHint = useCallback(() => {
    if (actionHintTimerRef.current) { clearTimeout(actionHintTimerRef.current); actionHintTimerRef.current = null; }
    setActionHint(null);
  }, []);

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const kind = selected ? detectFileKind(pathBasename(selected)) : 'binary';
  const isMd = Boolean(view === 'detail' && selected && isMarkdownFilename(pathBasename(selected)) && !editing);
  const canEdit = kind === 'text' || kind === 'table';
  const canLoadMore = truncated && lineBudget < FILE_PREVIEW_MAX_LINES && (kind === 'text' || kind === 'table') && !editing;

  const openFile = useCallback(async (filePath: string) => {
    const resolved = resolveWorkspacePath(filePath);
    setSelected(resolved); setView('detail'); setEditing(false); setDirty(false); setDetailLoading(true);
    setContent(''); setEditBuf(''); setAssetUrl(null); setActionHint(null); setTruncated(false);
    void listOpenOptionsForFile(resolved).then((opts) => { setFileOpeners(opts.openers); setOpenDefaultLabel(opts.defaultLabel || '打开'); }).catch(() => { setFileOpeners([]); setOpenDefaultLabel('打开'); });
    const initBudget = detectFileKind(pathBasename(resolved)) === 'table' ? 200 : FILE_PREVIEW_CHUNK_LINES;
    setLineBudget(initBudget); setMdMode('render'); setLoadingMore(false);
    const k = detectFileKind(pathBasename(resolved));
    try {
      if (k === 'image' || k === 'pdf') { const url = await toAssetUrl(resolved); setAssetUrl(url); if (!url) setActionHint('无法生成预览（需桌面壳 · 资源协议）'); }
      else if (k === 'text' || k === 'table') { const res = await readTextFile(resolved, initBudget); setContent(res.content); setEditBuf(res.content); openedContentRef.current = res.content; setTruncated(res.truncated); }
    } catch (e) { setActionHint(e instanceof Error ? e.message : String(e)); }
    finally { setDetailLoading(false); }
  }, []);

  const loadMoreLines = useCallback(async () => {
    if (!selected || loadingMore || editing) return;
    const next = nextFilePreviewLineBudget(lineBudget);
    if (next == null || next <= lineBudget) return;
    setLoadingMore(true);
    try { const res = await readTextFile(selected, next); setContent(res.content); if (!dirty) setEditBuf(res.content); setTruncated(res.truncated); setLineBudget(next); }
    catch (e) { showActionHint(e instanceof Error ? e.message : String(e)); }
    finally { setLoadingMore(false); }
  }, [dirty, editing, lineBudget, loadingMore, selected, showActionHint]);

  const saveFile = useCallback(async () => {
    if (!selected || !editing) return; clearActionHint();
    try {
      const cc = await readTextFile(selected, FILE_PREVIEW_MAX_LINES);
      if (cc.content !== openedContentRef.current) { const ok = window.confirm('文件已被外部修改，是否覆盖？'); if (!ok) return; }
      await writeTextFile(selected, editBuf); setContent(editBuf); openedContentRef.current = editBuf; setDirty(false); setEditing(false);
    } catch (e) { showActionHint(e instanceof Error ? e.message : '保存失败'); }
  }, [selected, editing, editBuf, clearActionHint, showActionHint]);

  const copyPath = useCallback((p: string | null, root: string, mode: 'abs' | 'rel' = 'rel') => {
    if (!p || !root) return;
    void navigator.clipboard.writeText(mode === 'rel' ? pathRelativeToRoot(p, root) || pathBasename(p) : p).then(() => clearActionHint(), () => showActionHint('复制失败'));
  }, [clearActionHint, showActionHint]);

  const defaultEditor = fileOpeners.find((op) => op.kind === 'editor' && op.id !== 'system-file-manager');

  const resetPreview = useCallback(() => {
    setSelected(null); setView('browse'); setEditing(false); setDirty(false);
    setContent(''); setEditBuf(''); setAssetUrl(null); setActionHint(null); setTruncated(false);
  }, []);

  const ret = {
    selected, view, content, editBuf, editing, dirty, truncated, lineBudget, loadingMore, mdMode, assetUrl, detailLoading,
    fileOpeners, openDefaultLabel, actionHint, pendingCount, kind, isMd, canEdit, canLoadMore, openedContentRef,
    openFile, loadMoreLines, saveFile, copyPath, setView, setMdMode, setEditing, setEditBuf, setDirty,
    setSelected, clearActionHint, showActionHint, resetPreview, defaultEditor, actionHintTimerRef, setPendingCount,
  };
  Object.defineProperty(ret, 'onDirtyChange', {
    get() { return onDirtyChangeRef.current; },
    set(cb: ((dirty: boolean) => void) | undefined) { onDirtyChangeRef.current = cb; },
    enumerable: true,
    configurable: true,
  });
  return ret as typeof ret & { onDirtyChange?: (dirty: boolean) => void };
}
