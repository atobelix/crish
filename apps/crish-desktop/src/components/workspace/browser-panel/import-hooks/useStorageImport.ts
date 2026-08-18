/**
 * 登录态导入 hook（D-01 G-03b 拆分产物 · 自 BrowserImportSection 迁出）。
 *
 * 拥有登录态导入域全部状态与行为：文件装载（applyStorageFile）与导入
 * （runStorageImport）。busy/setBusy 由主体传入（同一 BusyKind 编排）；
 * 错误统一走本 hook 错误出口（行内 role=alert + toast）。
 *
 * 注：storageError 槽与导出流（useExportAuth）共用——本 hook 是槽的唯一
 * 拥有者，setStorageError 同步外露给主体接线导出 hook。
 */
import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import {
  importStorageState,
  type StorageImportPayload,
} from '../../../../api/browserImportApi';
import {
  BROWSER_IMPORT_MAX_BYTES,
  isUsableJsonText,
} from '../../../../api/browserImportLib';
import { toast } from '../../../../services/toast/ToastContext';
import {
  readFileAsText,
  resultMessage,
  type BusyKind,
} from './browserImportShared';

export interface UseStorageImportOptions {
  busy: BusyKind;
  setBusy: Dispatch<SetStateAction<BusyKind>>;
}

export function useStorageImport({
  busy,
  setBusy,
}: UseStorageImportOptions) {
  const [storageError, setStorageError] = useState('');
  const [storageJson, setStorageJson] = useState('');
  const [storageFileName, setStorageFileName] = useState('');
  const [storageResult, setStorageResult] =
    useState<StorageImportPayload | null>(null);
  const storageFileRef = useRef<HTMLInputElement>(null);

  /** 登录态域错误出口：行内 role=alert + toast。 */
  const reportStorageError = useCallback(
    (prefix: string, msg: string) => {
      const full = `${prefix}${msg}`;
      setStorageError(full);
      toast.show(full);
    },
    []
  );

  const applyStorageFile = useCallback(
    async (file: File) => {
      if (file.size > BROWSER_IMPORT_MAX_BYTES) {
        reportStorageError(
          '登录态导入失败：',
          `文件超过 ${BROWSER_IMPORT_MAX_BYTES / 1024 / 1024}MB 上限`
        );
        return;
      }
      try {
        const text = await readFileAsText(file);
        setStorageJson(text);
        setStorageFileName(file.name);
        setStorageResult(null);
        setStorageError('');
      } catch (err) {
        reportStorageError('读取登录态文件失败：', String(err ?? ''));
      }
    },
    [reportStorageError]
  );

  const onStorageFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void applyStorageFile(file);
  };

  const runStorageImport = async () => {
    if (busy || !isUsableJsonText(storageJson)) return;
    setBusy('storageImport');
    setStorageError('');
    const res = await importStorageState(storageJson);
    if (res.status === 'ok') {
      setStorageResult(res.data);
    } else {
      reportStorageError('登录态导入失败：', resultMessage(res, ''));
    }
    setBusy(null);
  };

  return {
    storageError,
    storageJson,
    setStorageJson,
    setStorageResult,
    storageFileName,
    storageResult,
    storageFileRef,
    onStorageFileChange,
    runStorageImport,
    setStorageError,
  };
}
