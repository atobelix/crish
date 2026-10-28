/**
 * 登录态导出两段确认对话框（D-01 G-03b 拆分产物 · 自 BrowserImportSection 迁出）。
 * 纯展示壳：状态与回调由 useExportAuth 经主体接线传入，行为零改动
 * （① 授权读取确认——确认后才 authorized=true 实读（§5.2 零副作用）；
 * ② 域名清单预览确认后才「另存为」写盘（§5.4 写盘仅走前端显式另存为路径））。
 */
import React from 'react';
import { ConfirmDialog } from '@/components/ui';
import type { StorageStatePreview } from '../../../api/browserImportLib';
import type { BusyKind } from './import-hooks/browserImportShared';

export interface ExportAuthDialogsProps {
  /** 忙碌编排（导出中两对话框禁用）。 */
  busy: BusyKind;
  exportAuthOpen: boolean;
  setExportAuthOpen: (open: boolean) => void;
  exportPreviewOpen: boolean;
  setExportPreviewOpen: (open: boolean) => void;
  exportPreview: StorageStatePreview | null;
  setExportPreview: (preview: StorageStatePreview | null) => void;
  setExportedJson: (json: string) => void;
  runExportAuth: () => void;
  runExportSave: () => void;
}

export const ExportAuthDialogs: React.FC<ExportAuthDialogsProps> = ({
  busy,
  exportAuthOpen,
  setExportAuthOpen,
  exportPreviewOpen,
  setExportPreviewOpen,
  exportPreview,
  setExportPreview,
  setExportedJson,
  runExportAuth,
  runExportSave,
}) => (
  <>
    <ConfirmDialog
      open={exportAuthOpen}
      title="授权读取登录态"
      description={
        <>
          将读取浏览器会话的 cookie（<strong>仅内存传递，不写盘</strong>
          ；含 cookie value 明文，请勿泄露至日志）。确认后先展示域名清单预览，
          由你再次确认后才导出文件。未授权不会执行读取（零副作用）。
        </>
      }
      confirmLabel="继续读取"
      cancelLabel="取消"
      disabled={busy === 'storageExport'}
      onConfirm={() => {
        void runExportAuth();
      }}
      onCancel={() => setExportAuthOpen(false)}
    />
    <ConfirmDialog
      open={exportPreviewOpen}
      title="确认导出登录态"
      description={
        exportPreview ? (
          <>
            将导出 {exportPreview.cookieCount} 条 cookie
            {exportPreview.origins > 0
              ? `、${exportPreview.origins} 个 origin`
              : ''}
            ，涉及域名：
            <code>
              {exportPreview.domains.length > 0
                ? exportPreview.domains.join('、')
                : '（无）'}
            </code>
            。导出文件含 cookie value 明文，请谨慎保管；保存位置由「另存为」
            对话框决定（不自动写盘）。
          </>
        ) : (
          '导出内容为空（未读取到 cookie）。'
        )
      }
      confirmLabel="确认导出"
      cancelLabel="取消"
      disabled={busy === 'storageExport'}
      onConfirm={runExportSave}
      onCancel={() => {
        setExportPreviewOpen(false);
        setExportPreview(null);
        setExportedJson('');
      }}
    />
  </>
);
