import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import {
  countPendingFileAnnotations,
  detectFileKind,
  FILE_PREVIEW_CODE_BUDGET,
  FILE_PREVIEW_MAX_LINES,
  isMarkdownFilename,
  nextFilePreviewLineBudget,
  pathBasename,
  readTextFile,
  resolveReadableFilePath,
  toAssetUrl,
  writeTextFile,
} from '../../../api/workspaceFsApi';
import {
  listOpenOptionsForFile,
  type HostOpener,
} from '../../../api/hostOpenersApi';
import { pathRelativeToRoot } from '../../../api/workspaceFsApi';
import { ConfirmDialog } from '../../ui';
import { useConfirmGate } from '../../../hooks/useConfirmGate';
import { useWordWrapPreference } from './useWordWrapPreference';
import { isJsonFileOrContent, formatJsonSafe } from '../jsonFormatUtils';

export type ViewMode = 'browse' | 'detail';

export function useFilePreview() {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('browse');

  const [editState, setEditState] = useState<{
    content: string;
    editBuf: string;
    editing: boolean;
    dirty: boolean;
  }>({
    content: '',
    editBuf: '',
    editing: false,
    dirty: false,
  });
  const content = editState.content;
  const editBuf = editState.editBuf;
  const editing = editState.editing;
  const dirty = editState.dirty;

  const setContent = (val: React.SetStateAction<string>) =>
    setEditState((prev) => ({
      ...prev,
      content: typeof val === 'function' ? val(prev.content) : val,
    }));
  const setEditBuf = (val: React.SetStateAction<string>) =>
    setEditState((prev) => ({
      ...prev,
      editBuf: typeof val === 'function' ? val(prev.editBuf) : val,
    }));
  const setEditing = (val: React.SetStateAction<boolean>) =>
    setEditState((prev) => ({
      ...prev,
      editing: typeof val === 'function' ? val(prev.editing) : val,
    }));
  const setDirty = (val: React.SetStateAction<boolean>) =>
    setEditState((prev) => ({
      ...prev,
      dirty: typeof val === 'function' ? val(prev.dirty) : val,
    }));

  const [loadState, setLoadState] = useState<{
    detailLoading: boolean;
    loadingMore: boolean;
    truncated: boolean;
    lineBudget: number;
  }>({
    detailLoading: false,
    loadingMore: false,
    truncated: false,
    lineBudget: FILE_PREVIEW_CODE_BUDGET,
  });
  const detailLoading = loadState.detailLoading;
  const loadingMore = loadState.loadingMore;
  const truncated = loadState.truncated;
  const lineBudget = loadState.lineBudget;

  const setDetailLoading = (val: React.SetStateAction<boolean>) =>
    setLoadState((prev) => ({
      ...prev,
      detailLoading: typeof val === 'function' ? val(prev.detailLoading) : val,
    }));
  const setLoadingMore = (val: React.SetStateAction<boolean>) =>
    setLoadState((prev) => ({
      ...prev,
      loadingMore: typeof val === 'function' ? val(prev.loadingMore) : val,
    }));
  const setTruncated = (val: React.SetStateAction<boolean>) =>
    setLoadState((prev) => ({
      ...prev,
      truncated: typeof val === 'function' ? val(prev.truncated) : val,
    }));
  const setLineBudget = (val: React.SetStateAction<number>) =>
    setLoadState((prev) => ({
      ...prev,
      lineBudget: typeof val === 'function' ? val(prev.lineBudget) : val,
    }));

  const [mdMode, setMdMode] = useState<'render' | 'source'>('render');
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  const [openersState, setOpenersState] = useState<{
    fileOpeners: HostOpener[];
    openDefaultLabel: string;
  }>({
    fileOpeners: [],
    openDefaultLabel: '打开',
  });
  const fileOpeners = openersState.fileOpeners;
  const openDefaultLabel = openersState.openDefaultLabel;

  const setFileOpeners = (val: React.SetStateAction<HostOpener[]>) =>
    setOpenersState((prev) => ({
      ...prev,
      fileOpeners: typeof val === 'function' ? val(prev.fileOpeners) : val,
    }));
  const setOpenDefaultLabel = (val: React.SetStateAction<string>) =>
    setOpenersState((prev) => ({
      ...prev,
      openDefaultLabel:
        typeof val === 'function' ? val(prev.openDefaultLabel) : val,
    }));

  const [actionHint, setActionHint] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(() =>
    countPendingFileAnnotations()
  );
  const openedContentRef = useRef<string>('');
  const actionHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDirtyChangeRef = useRef<((dirty: boolean) => void) | undefined>(
    undefined
  );
  // window.confirm → ConfirmDialog Promise 桥（批次 4.1，04-detail §2.1.1）；
  // hook 不直接渲染，渲染物经返回值交给宿主（FilesCard）挂载
  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const showActionHint = useCallback((msg: string) => {
    setActionHint(msg);
    if (actionHintTimerRef.current) clearTimeout(actionHintTimerRef.current);
    actionHintTimerRef.current = setTimeout(() => {
      setActionHint(null);
      actionHintTimerRef.current = null;
    }, 4800);
  }, []);

  const clearActionHint = useCallback(() => {
    if (actionHintTimerRef.current) {
      clearTimeout(actionHintTimerRef.current);
      actionHintTimerRef.current = null;
    }
    setActionHint(null);
  }, []);

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const [wordWrap, toggleWordWrap] = useWordWrapPreference();
  const [isFormatted, setIsFormatted] = useState(false);
  const [formattedContent, setFormattedContent] = useState('');

  const kind = selected ? detectFileKind(pathBasename(selected)) : 'binary';
  const isMd = Boolean(
    view === 'detail' &&
    selected &&
    isMarkdownFilename(pathBasename(selected)) &&
    !editing
  );
  const canEdit = kind === 'text' || kind === 'table';
  const canLoadMore =
    truncated &&
    lineBudget < FILE_PREVIEW_MAX_LINES &&
    (kind === 'text' || kind === 'table') &&
    !editing;

  const isJson = Boolean(
    selected &&
    (kind === 'text' || kind === 'table') &&
    isJsonFileOrContent(selected, content)
  );

  const toggleFormatJson = useCallback(async () => {
    if (isFormatted) {
      setIsFormatted(false);
      setFormattedContent('');
      return;
    }

    let raw = content;
    if (truncated && selected) {
      try {
        const full = await readTextFile(selected, FILE_PREVIEW_MAX_LINES);
        raw = full.content;
        setContent(full.content);
        setTruncated(full.truncated);
        setLineBudget(FILE_PREVIEW_MAX_LINES);
      } catch (err) {
        showActionHint(
          `加载完整文件失败：${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
    }

    const res = formatJsonSafe(raw, 2, selected);
    if (res.success) {
      setFormattedContent(res.formatted);
      setIsFormatted(true);
    } else {
      showActionHint(`JSON 格式化失败：${res.error || '语法错误'}`);
    }
  }, [isFormatted, content, truncated, selected, showActionHint]);

  const openFile = useCallback(async (filePath: string) => {
    const resolved = resolveReadableFilePath(filePath) || filePath;
    setSelected(resolved);
    setView('detail');
    setEditing(false);
    setDirty(false);
    setDetailLoading(true);
    setContent('');
    setEditBuf('');
    setAssetUrl(null);
    setActionHint(null);
    setTruncated(false);
    setIsFormatted(false);
    setFormattedContent('');
    void listOpenOptionsForFile(resolved)
      .then((opts) => {
        setFileOpeners(opts.openers);
        setOpenDefaultLabel(opts.defaultLabel || '打开');
      })
      .catch(() => {
        setFileOpeners([]);
        setOpenDefaultLabel('打开');
      });
    const k = detectFileKind(pathBasename(resolved));
    const initBudget = k === 'table' ? 200 : FILE_PREVIEW_CODE_BUDGET;
    setLineBudget(initBudget);
    setMdMode('render');
    setLoadingMore(false);
    try {
      if (k === 'image' || k === 'pdf') {
        const url = await toAssetUrl(resolved);
        setAssetUrl(url);
        if (!url) setActionHint('无法生成预览（需桌面壳 · 资源协议）');
      } else if (k === 'text' || k === 'table') {
        const res = await readTextFile(resolved, initBudget);
        setContent(res.content);
        setEditBuf(res.content);
        openedContentRef.current = res.content;
        setTruncated(res.truncated);
      }
    } catch (e) {
      setActionHint(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadMoreLines = useCallback(async () => {
    if (!selected || loadingMore || editing) return;
    const next = nextFilePreviewLineBudget(lineBudget);
    if (next == null || next <= lineBudget) return;
    setLoadingMore(true);
    try {
      const res = await readTextFile(selected, next);
      setContent(res.content);
      if (!dirty) setEditBuf(res.content);
      setTruncated(res.truncated);
      setLineBudget(next);
    } catch (e) {
      showActionHint(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [dirty, editing, lineBudget, loadingMore, selected, showActionHint]);

  const saveFile = useCallback(async () => {
    if (!selected || !editing) return;
    clearActionHint();
    try {
      const cc = await readTextFile(selected, FILE_PREVIEW_MAX_LINES);
      if (cc.content !== openedContentRef.current) {
        const ok = await confirmGate({
          title: '覆盖外部修改',
          description: '文件已被外部修改，是否覆盖？',
          confirmLabel: '确认覆盖',
        });
        if (!ok) return;
      }
      await writeTextFile(selected, editBuf, true);
      setContent(editBuf);
      openedContentRef.current = editBuf;
      setDirty(false);
      setEditing(false);
    } catch (e) {
      showActionHint(e instanceof Error ? e.message : '保存失败');
    }
  }, [
    selected,
    editing,
    editBuf,
    clearActionHint,
    showActionHint,
    confirmGate,
  ]);

  const copyPath = useCallback(
    (p: string | null, root: string, mode: 'abs' | 'rel' = 'rel') => {
      if (!p || !root) return;
      void navigator.clipboard
        .writeText(
          mode === 'rel' ? pathRelativeToRoot(p, root) || pathBasename(p) : p
        )
        .then(
          () => clearActionHint(),
          () => showActionHint('复制失败')
        );
    },
    [clearActionHint, showActionHint]
  );

  const defaultEditor = fileOpeners.find(
    (op) => op.kind === 'editor' && op.id !== 'system-file-manager'
  );

  const resetPreview = useCallback(() => {
    setSelected(null);
    setView('browse');
    setEditing(false);
    setDirty(false);
    setContent('');
    setEditBuf('');
    setAssetUrl(null);
    setActionHint(null);
    setTruncated(false);
    setIsFormatted(false);
    setFormattedContent('');
  }, []);

  const ret = {
    selected,
    view,
    content,
    editBuf,
    editing,
    dirty,
    truncated,
    lineBudget,
    loadingMore,
    mdMode,
    assetUrl,
    detailLoading,
    fileOpeners,
    openDefaultLabel,
    actionHint,
    pendingCount,
    kind,
    isMd,
    canEdit,
    canLoadMore,
    openedContentRef,
    wordWrap,
    toggleWordWrap,
    isJson,
    isFormatted,
    formattedContent,
    toggleFormatJson,
    openFile,
    loadMoreLines,
    saveFile,
    copyPath,
    setView,
    setMdMode,
    setEditing,
    setEditBuf,
    setDirty,
    setSelected,
    clearActionHint,
    showActionHint,
    resetPreview,
    defaultEditor,
    actionHintTimerRef,
    setPendingCount,
    confirmGateView: renderConfirmGate(createElement(ConfirmDialog)),
  };
  Object.defineProperty(ret, 'onDirtyChange', {
    get() {
      return onDirtyChangeRef.current;
    },
    set(cb: ((dirty: boolean) => void) | undefined) {
      onDirtyChangeRef.current = cb;
    },
    enumerable: true,
    configurable: true,
  });
  return ret as typeof ret & { onDirtyChange?: (dirty: boolean) => void };
}
