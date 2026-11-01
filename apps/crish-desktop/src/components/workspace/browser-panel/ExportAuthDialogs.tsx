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
import { useI18n } from '../../../i18n';

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
}) => {
  const { t, language } = useI18n();
  return (
    <>
      <ConfirmDialog
        open={exportAuthOpen}
        title={t('settings.browserImport.exportAuthTitle', '授权读取登录态')}
        description={
          <>
            {t(
              'settings.browserImport.exportAuthDescPre',
              '将读取浏览器会话的 cookie（'
            )}
            <strong>
              {t(
                'settings.browserImport.exportAuthDescStrong',
                '仅内存传递，不写盘'
              )}
            </strong>
            {t(
              'settings.browserImport.exportAuthDescPost',
              '；含 cookie value 明文，请勿泄露至日志）。确认后先展示域名清单预览，由你再次确认后才导出文件。未授权不会执行读取（零副作用）。'
            )}
          </>
        }
        confirmLabel={t('settings.browserImport.continueRead', '继续读取')}
        cancelLabel={t('common.cancel', '取消')}
        disabled={busy === 'storageExport'}
        onConfirm={() => {
          void runExportAuth();
        }}
        onCancel={() => setExportAuthOpen(false)}
      />
      <ConfirmDialog
        open={exportPreviewOpen}
        title={t('settings.browserImport.exportConfirmTitle', '确认导出登录态')}
        description={
          exportPreview ? (
            <>
              {t(
                'settings.browserImport.exportPreviewLead',
                '将导出 {count} 条 cookie',
                { count: exportPreview.cookieCount }
              )}
              {exportPreview.origins > 0
                ? t(
                    'settings.browserImport.exportPreviewOrigins',
                    '、{count} 个 origin',
                    { count: exportPreview.origins }
                  )
                : ''}
              {t(
                'settings.browserImport.exportPreviewDomainsLead',
                '，涉及域名：'
              )}
              <code>
                {exportPreview.domains.length > 0
                  ? exportPreview.domains.join(
                      language === 'en-US' ? ', ' : '、'
                    )
                  : t(
                      'settings.browserImport.exportPreviewNoDomains',
                      '（无）'
                    )}
              </code>
              {t(
                'settings.browserImport.exportPreviewTail',
                '。导出文件含 cookie value 明文，请谨慎保管；保存位置由「另存为」对话框决定（不自动写盘）。'
              )}
            </>
          ) : (
            t(
              'settings.browserImport.exportEmpty',
              '导出内容为空（未读取到 cookie）。'
            )
          )
        }
        confirmLabel={t('settings.browserImport.confirmExport', '确认导出')}
        cancelLabel={t('common.cancel', '取消')}
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
};
