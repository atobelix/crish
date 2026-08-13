/**
 * 登录态导出 hook（D-01 G-03b 拆分产物 · 自 BrowserImportSection 迁出）。
 *
 * 两段确认流（① 授权读取对话框 → 确认后才 authorized=true 实读（§5.2
 * 零副作用）；② 域名清单预览对话框 → 确认后才「另存为」写盘（§5.4 写盘
 * 仅走前端显式另存为路径））。setBusy 由主体传入（同一 BusyKind 编排，
 * 本 hook 不读 busy——对话框禁用态由主体派生传入）；错误出口复用登录态
 * 导入的 storageError 槽（主体接线 setStorageError 传入——行内展示与
 * toast 与导入域一致）。
 */
import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { exportStorageState } from '../../../../api/browserImportApi';
import {
  parseStorageStatePreview,
  storageStateExportFilename,
  type StorageStatePreview,
} from '../../../../api/browserImportLib';
import { downloadTextFile } from '../../../../api/sessionExport';
import type { ShowToastFn } from '../../../../hooks/useToastQueue';
import { resultMessage, type BusyKind } from './browserImportShared';

export interface UseExportAuthOptions {
  setBusy: Dispatch<SetStateAction<BusyKind>>;
  onShowToast: ShowToastFn;
  /** 登录态错误展示槽（与导入域共用同一行内错误 slot）。 */
  setStorageError: Dispatch<SetStateAction<string>>;
  /** 测试注入：登录态「另存为」写盘（缺省 downloadTextFile）。 */
  saveExport?: (filename: string, content: string) => void;
}

export function useExportAuth({
  setBusy,
  onShowToast,
  setStorageError,
  saveExport,
}: UseExportAuthOptions) {
  const [exportAuthOpen, setExportAuthOpen] = useState(false);
  const [exportPreviewOpen, setExportPreviewOpen] = useState(false);
  const [exportPreview, setExportPreview] =
    useState<StorageStatePreview | null>(null);
  const [exportedJson, setExportedJson] = useState('');

  /** 登录态域错误出口（导出/保存失败共用）：行内 role=alert + toast。 */
  const reportStorageError = useCallback(
    (prefix: string, msg: string) => {
      const full = `${prefix}${msg}`;
      setStorageError(full);
      onShowToast(full);
    },
    [onShowToast, setStorageError]
  );

  // 登录态导出：两段确认（① 授权读取 → ② 预览域名清单后确认写盘）
  const runExportAuth = async () => {
    setExportAuthOpen(false);
    setBusy('storageExport');
    setStorageError('');
    const res = await exportStorageState(true);
    if (res.status === 'ok') {
      setExportedJson(res.data);
      setExportPreview(parseStorageStatePreview(res.data));
      setExportPreviewOpen(true);
    } else {
      reportStorageError('登录态导出失败：', resultMessage(res, ''));
    }
    setBusy(null);
  };

  const runExportSave = () => {
    const filename = storageStateExportFilename();
    const doSave =
      saveExport ??
      ((f: string, c: string) => {
        downloadTextFile(f, c, { mimeType: 'application/json;charset=utf-8' });
      });
    try {
      doSave(filename, exportedJson);
      setExportPreviewOpen(false);
      setExportedJson('');
      setExportPreview(null);
    } catch (err) {
      reportStorageError('登录态保存失败：', String(err ?? ''));
    }
  };

  return {
    exportAuthOpen,
    setExportAuthOpen,
    exportPreviewOpen,
    setExportPreviewOpen,
    exportPreview,
    setExportPreview,
    setExportedJson,
    runExportAuth,
    runExportSave,
  };
}
