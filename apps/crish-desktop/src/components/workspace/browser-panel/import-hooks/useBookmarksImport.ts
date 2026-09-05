/**
 * 书签导入 hook（D-01 G-03b 拆分产物 · 自 BrowserImportSection 迁出）。
 *
 * 拥有书签域全部状态与行为：文件三通道（选择 / 拖入 / 路径读取）共用装载
 * （applyBookmarksContent）、导入（runBookmarksImport）。busy/setBusy 由
 * 主体传入（同一 BusyKind 编排）；错误统一走本 hook 错误出口
 * （行内 role=alert + toast，仅错误走 toast——产品禁令）。
 */
import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, DragEvent, SetStateAction } from 'react';
import {
  importBookmarks,
  readTextFileAtPath,
  type BookmarksImportPayload,
} from '../../../../api/browserImportApi';
import {
  BROWSER_IMPORT_MAX_BYTES,
  isUsableJsonText,
} from '../../../../api/browserImportLib';
import type { } from '../../../../hooks/useToastQueue';
import {
  readFileAsText,
  resultMessage,
  type BusyKind,
} from './browserImportShared';

import { toast } from '../../../../services/toast/ToastContext';

export interface UseBookmarksImportOptions {
  busy: BusyKind;
  setBusy: Dispatch<SetStateAction<BusyKind>>;
  onShowToast?: (message: string) => void;
}

export function useBookmarksImport({
  busy,
  setBusy,
  onShowToast,
}: UseBookmarksImportOptions) {
  const [bookmarksJson, setBookmarksJson] = useState('');
  const [bookmarksFileName, setBookmarksFileName] = useState('');
  const [bookmarksResult, setBookmarksResult] =
    useState<BookmarksImportPayload | null>(null);
  const [bookmarksError, setBookmarksError] = useState('');
  const [bookmarksPath, setBookmarksPath] = useState('');
  const bookmarksFileRef = useRef<HTMLInputElement>(null);

  /** 书签域错误出口：行内 role=alert + toast。 */
  const reportBookmarksError = useCallback(
    (prefix: string, msg: string) => {
      const full = `${prefix}${msg}`;
      setBookmarksError(full);
      onShowToast?.(full);
      toast.show(full);
    },
    [onShowToast]
  );

  // 书签：文件三通道（选择 / 拖入 / 路径读取）共用装载
  const applyBookmarksContent = useCallback(
    async (file: File) => {
      if (file.size > BROWSER_IMPORT_MAX_BYTES) {
        reportBookmarksError(
          '书签导入失败：',
          `文件超过 ${BROWSER_IMPORT_MAX_BYTES / 1024 / 1024}MB 上限`
        );
        return;
      }
      try {
        const text = await readFileAsText(file);
        setBookmarksJson(text);
        setBookmarksFileName(file.name);
        setBookmarksResult(null);
        setBookmarksError('');
      } catch (err) {
        reportBookmarksError('读取书签文件失败：', String(err ?? ''));
      }
    },
    [reportBookmarksError]
  );

  const onBookmarksFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void applyBookmarksContent(file);
  };

  const onBookmarksDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) void applyBookmarksContent(file);
  };

  const runBookmarksPathRead = async () => {
    if (busy || !bookmarksPath.trim()) return;
    setBusy('bookmarksPath');
    setBookmarksError('');
    try {
      const text = await readTextFileAtPath(bookmarksPath.trim());
      if (text === null) {
        reportBookmarksError(
          '路径读取不可用：',
          '非 Tauri 环境不支持按路径读取，请用文件选择或拖入'
        );
      } else {
        setBookmarksJson(text);
        setBookmarksFileName(bookmarksPath.trim());
        setBookmarksResult(null);
      }
    } finally {
      setBusy(null);
    }
  };

  const runBookmarksImport = async () => {
    if (busy || !isUsableJsonText(bookmarksJson)) return;
    setBusy('bookmarks');
    setBookmarksError('');
    const res = await importBookmarks(bookmarksJson);
    if (res.status === 'ok') {
      setBookmarksResult(res.data);
      const msg = `书签导入成功：新增 ${res.data.inserted} 条，跳过 ${res.data.skippedDupes} 条`;
      onShowToast?.(msg);
      toast.show(msg);
    } else {
      reportBookmarksError('书签导入失败：', resultMessage(res, ''));
    }
    setBusy(null);
  };

  const importBookmarksFile = async (file: File) => {
    if (file.size > BROWSER_IMPORT_MAX_BYTES) {
      reportBookmarksError(
        '书签导入失败：',
        `文件超过 ${BROWSER_IMPORT_MAX_BYTES / 1024 / 1024}MB 上限`
      );
      return;
    }
    setBusy('bookmarks');
    setBookmarksError('');
    try {
      const text = await readFileAsText(file);
      setBookmarksJson(text);
      setBookmarksFileName(file.name);
      const res = await importBookmarks(text);
      if (res.status === 'ok') {
        setBookmarksResult(res.data);
        const msg = `书签导入成功：新增 ${res.data.inserted} 条，跳过 ${res.data.skippedDupes} 条`;
        onShowToast?.(msg);
        toast.show(msg);
      } else {
        reportBookmarksError('书签导入失败：', resultMessage(res, ''));
      }
    } catch (err) {
      reportBookmarksError('读取书签文件失败：', String(err ?? ''));
    } finally {
      setBusy(null);
    }
  };

  return {
    bookmarksJson,
    bookmarksFileName,
    bookmarksResult,
    bookmarksError,
    bookmarksPath,
    setBookmarksPath,
    bookmarksFileRef,
    onBookmarksFileChange,
    onBookmarksDrop,
    runBookmarksPathRead,
    runBookmarksImport,
    applyBookmarksContent: importBookmarksFile,
    importBookmarksFile,
  };
}
