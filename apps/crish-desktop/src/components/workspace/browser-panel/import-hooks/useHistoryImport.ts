/**
 * 历史导入 + 列表管理 hook（D-01 G-03b 拆分产物 · 自 BrowserImportSection 迁出）。
 *
 * 拥有历史导入域（runHistoryImport）与「已导入数据」列表域
 * （loadList/toggleList/refreshList + historyLimit 控制）的全部状态与行为
 * （D-01 §4.2 分配：列表管理归入本 hook）。busy/setBusy 由主体传入
 * （同一 BusyKind 编排）；错误统一走本 hook 错误出口（行内 role=alert + toast）。
 */
import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  importHistory,
  listBookmarks,
  listHistory,
  type HistoryImportPayload,
  type ImportedBookmarkRow,
  type ImportedHistoryRow,
} from '../../../../api/browserImportApi';
import { toast } from '../../../../services/toast/ToastContext';
import { resultMessage, type BusyKind } from './browserImportShared';

export interface UseHistoryImportOptions {
  busy: BusyKind;
  setBusy: Dispatch<SetStateAction<BusyKind>>;
  onShowToast?: (message: string) => void;
}

export function useHistoryImport({
  busy,
  setBusy,
  onShowToast,
}: UseHistoryImportOptions) {
  // ── 历史导入 ──
  const [historyPath, setHistoryPath] = useState('');
  const [historyResult, setHistoryResult] =
    useState<HistoryImportPayload | null>(null);
  const [historyError, setHistoryError] = useState('');

  /** 历史域错误出口：行内 role=alert + toast。 */
  const reportHistoryError = useCallback(
    (prefix: string, msg: string) => {
      const full = `${prefix}${msg}`;
      setHistoryError(full);
      onShowToast?.(full);
      toast.show(full);
    },
    [onShowToast]
  );

  const runHistoryImport = async () => {
    if (busy || !historyPath.trim()) return;
    setBusy('history');
    setHistoryError('');
    const res = await importHistory(historyPath.trim());
    if (res.status === 'ok') {
      setHistoryResult(res.data);
    } else {
      reportHistoryError('历史导入失败：', resultMessage(res, ''));
    }
    setBusy(null);
  };

  // ── 列表（可折叠 + 历史 limit 控制 + 时序保护） ──
  const [listTab, setListTab] = useState<'bookmarks' | 'history' | null>(null);
  const [historyLimit, setHistoryLimit] = useState('50');
  const [bookmarkRows, setBookmarkRows] = useState<
    ImportedBookmarkRow[] | null
  >(null);
  const [historyRows, setHistoryRows] = useState<ImportedHistoryRow[] | null>(
    null
  );
  const [listError, setListError] = useState('');
  const reqSeqRef = useRef(0);

  /** 列表域错误出口：行内 role=alert + toast。 */
  const reportListError = useCallback(
    (prefix: string, msg: string) => {
      const full = `${prefix}${msg}`;
      setListError(full);
      onShowToast?.(full);
      toast.show(full);
    },
    [onShowToast]
  );

  const loadList = async (tab: 'bookmarks' | 'history') => {
    const currentSeq = ++reqSeqRef.current;
    setBusy('list');
    try {
      if (tab === 'bookmarks') {
        const res = await listBookmarks();
        if (currentSeq !== reqSeqRef.current) return;
        if (res.status === 'ok') setBookmarkRows(res.data);
        else reportListError('书签列表加载失败：', resultMessage(res, ''));
      } else {
        const limit = Math.max(1, Math.floor(Number(historyLimit)) || 50);
        const res = await listHistory(undefined, limit);
        if (currentSeq !== reqSeqRef.current) return;
        if (res.status === 'ok') setHistoryRows(res.data);
        else reportListError('历史列表加载失败：', resultMessage(res, ''));
      }
    } finally {
      if (currentSeq === reqSeqRef.current) {
        setBusy(null);
      }
    }
  };

  const toggleList = async (tab: 'bookmarks' | 'history') => {
    setListError('');
    if (listTab === tab) {
      setListTab(null);
      return;
    }
    setListTab(tab);
    await loadList(tab);
  };

  const refreshList = async () => {
    if (!listTab || busy === 'list') return;
    setListError('');
    await loadList(listTab);
  };

  return {
    historyPath,
    setHistoryPath,
    historyResult,
    historyError,
    runHistoryImport,
    listTab,
    historyLimit,
    setHistoryLimit,
    bookmarkRows,
    historyRows,
    listError,
    toggleList,
    refreshList,
  };
}
